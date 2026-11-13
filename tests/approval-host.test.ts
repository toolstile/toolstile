import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInstanceApprovals } from "../apps/web/src/server/approvals";
import { digest, issueToken, secretBox } from "../packages/auth/src/index";
import {
	approvalRequest,
	emptyRules,
	type Runtime,
} from "../packages/gateway/src/index";
import { createAccountTestDatabase } from "./account-database";

// Expose the private userRuntime through its dashboard tool-test seam. Only the
// final testTool invocation is replaced; host authorization/admission remain real.
// These tests deliberately do not contact upstream MCP services.
const observed = vi.hoisted(() => ({
	runtime: undefined as Runtime | undefined,
}));
vi.mock("../packages/gateway/src/index", async (original) => ({
	...(await original<typeof import("../packages/gateway/src/index")>()),
	testAgentTool: async (runtime: Runtime) => {
		observed.runtime = runtime;
		return { isError: false, preview: "", truncated: false };
	},
}));
const source = process.env.TEST_DATABASE_URL;
describe.skipIf(!source)("instance approval HOST integration", () => {
	const _schema = `approval_host_${randomUUID().replaceAll("-", "")}`;
	const key = "c".repeat(64),
		box = secretBox(key);
	let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
	let backend: typeof import("../apps/web/src/server/runtime");
	let host: ReturnType<typeof createInstanceApprovals>;
	beforeAll(async () => {
		storage = await createAccountTestDatabase();
		vi.stubEnv("DATABASE_URL", storage.url);
		vi.stubEnv("BETTER_AUTH_URL", "http://localhost:4310");
		vi.stubEnv("BETTER_AUTH_SECRET", "approval-host-local-secret-".repeat(3));
		vi.stubEnv("ENCRYPTION_KEY", key);
		vi.stubEnv("TOOLSTILE_TELEMETRY_URL", "");
		backend = await import("../apps/web/src/server/runtime");
		host = createInstanceApprovals({
			pool: backend.pool,
			box,
			secret: key,
			baseURL: "http://localhost:4310",
			toolReviews: async () => new Map(),
		});
	}, 30000);
	afterAll(async () => {
		await backend?.pool.end();
		await storage?.close();
		vi.unstubAllEnvs();
	});
	async function fixture() {
		const owner = randomUUID(),
			other = randomUUID(),
			device = randomUUID(),
			agent = randomUUID(),
			connection = randomUUID();
		for (const user of [owner, other]) {
			await backend.pool.query(
				'insert into "user"(id,name,email) values($1,$1,$2)',
				[user, `${user}@test.invalid`],
			);
			await backend.pool.query(
				'insert into session(id,token,"userId","expiresAt") values($1,$2,$3,now() + (3600000) * interval \'1 millisecond\')',
				[`session-${user}`, randomUUID(), user],
			);
		}
		await backend.pool.query(
			"insert into devices(id,\"ownerId\",label) values($1,$2,'Laptop')",
			[device, owner],
		);
		await backend.pool.query(
			'insert into agents(id,"ownerId","deviceId",label) values($1,$2,$3,\'Agent\')',
			[agent, owner, device],
		);
		const token = issueToken();
		await backend.pool.query(
			'insert into authorizations(id,"agentId","tokenHash") values($1,$2,$3)',
			[randomUUID(), agent, digest(token)],
		);
		await backend.pool.query(
			"insert into connections(id,\"ownerId\",label,url,\"encryptedHeaders\") values($1,$2,'Tracker','https://tracker.example/mcp',$3)",
			[connection, owner, box.encrypt({ Authorization: "Bearer local-only" })],
		);
		const rules = { ...emptyRules(), requireApproval: ["create_issue"] };
		await backend.pool.query(
			'insert into grants(id,"agentId","connectionId",rules) values($1,$2,$3,$4)',
			[randomUUID(), agent, connection, JSON.stringify(rules)],
		);
		const actor = {
			userId: owner,
			scopeId: owner,
			sessionId: `session-${owner}`,
		};
		await backend.services.testTool(actor, {
			agentId: agent,
			connectionId: connection,
			name: "create_issue",
			arguments: {},
		});
		const runtime = observed.runtime;
		if (!runtime?.approvals) throw new Error("Agent runtime approvals missing");
		const approvals = runtime.approvals;
		const upstream = (await runtime.connections())[0];
		const request = approvalRequest(upstream, {
			name: "create_issue",
			arguments: { title: randomUUID() },
		});
		const pending = await approvals.begin(request, randomUUID());
		expect(pending.kind).toBe("pending");
		const approve = () =>
			backend.services.decideApproval(actor, {
				id: pending.id,
				decision: "approve",
			});
		const claim = (id = randomUUID()) => approvals.begin(request, id);
		return {
			owner,
			other,
			agent,
			connection,
			actor,
			runtime,
			request,
			pending,
			approve,
			claim,
			token,
		};
	}
	it("refuses a decision whose session was signed out after its snapshot", async () => {
		const f = await fixture();
		// Another request holds the approval row, so the decision's first statement (and its
		// snapshot) waits; the auth library signs the reviewer out meanwhile.
		const holder = await backend.pool.connect();
		await holder.query("BEGIN");
		await holder.query("select id from tool_approvals where id=$1 for update", [
			f.pending.id,
		]);
		const decided = Promise.allSettled([f.approve()]);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await backend.pool.query("delete from session where id=$1", [
			f.actor.sessionId,
		]);
		await holder.query("COMMIT");
		holder.release();
		const [outcome] = await decided;
		expect(outcome).toMatchObject({
			status: "rejected",
			reason: { code: "UNAUTHORIZED" },
		});
		expect(
			(
				await backend.pool.query(
					"select status from tool_approvals where id=$1",
					[f.pending.id],
				)
			).rows[0].status,
		).toBe("pending");
	});
	it("requires the owner's live dashboard session; bearer identity and other users cannot review", async () => {
		const f = await fixture();
		await expect(
			host.services.approvalDetail(f.actor, f.pending.id),
		).resolves.toMatchObject({
			canDecide: true,
			destination: "https://tracker.example",
		});
		for (const actor of [
			{ userId: f.owner, scopeId: f.owner },
			{ ...f.actor, sessionId: `session-${f.other}` },
		])
			await expect(
				backend.services.decideApproval(actor, {
					id: f.pending.id,
					decision: "approve",
				}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		const response = await backend.handleRpc(
			new Request("http://localhost:4310/api/rpc/decideApproval", {
				method: "POST",
				headers: {
					authorization: `Bearer ${f.token}`,
					"content-type": "application/json",
					origin: "http://localhost:4310",
				},
				body: JSON.stringify({
					json: { id: f.pending.id, decision: "approve" },
				}),
			}),
		);
		expect(response.status).toBe(401);
		const foreign = {
			userId: f.other,
			scopeId: f.other,
			sessionId: `session-${f.other}`,
		};
		await expect(
			host.services.approvalDetail(foreign, f.pending.id),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			host.services.listApprovals(foreign, {}),
		).resolves.toMatchObject({ total: 0 });
		await f.approve();
		await expect(f.claim()).resolves.toMatchObject({
			kind: "permit",
			id: f.pending.id,
		});
	});
	it("rejects expired sessions before deciding", async () => {
		const f = await fixture();
		await backend.pool.query(
			"update session set \"expiresAt\"=now() - (1000) * interval '1 millisecond' where id=$1",
			[f.actor.sessionId],
		);
		await expect(f.approve()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
	it.each(["credential", "rules", "suspended", "revoked"])(
		"invalidates approval at claim after live %s changes",
		async (change) => {
			const f = await fixture();
			await f.approve();
			if (change === "credential")
				await backend.pool.query(
					'update connections set "encryptedHeaders"=$2 where id=$1',
					[f.connection, box.encrypt({ Authorization: "Bearer rotated" })],
				);
			if (change === "rules")
				await backend.pool.query(
					'update grants set rules=$2 where "agentId"=$1',
					[f.agent, JSON.stringify({ ...emptyRules(), full: true })],
				);
			if (change === "suspended")
				await backend.pool.query(
					'insert into profiles("userId",suspended) values($1,true)',
					[f.owner],
				);
			if (change === "revoked")
				await backend.pool.query(
					'update authorizations set "revokedAt"=now() where "agentId"=$1',
					[f.agent],
				);
			await expect(f.claim()).resolves.toMatchObject({ kind: "pending" });
			expect(
				(
					await backend.pool.query(
						'select status,"encryptedRequest" from tool_approvals where id=$1',
						[f.pending.id],
					)
				).rows[0],
			).toEqual({ status: "invalidated", encryptedRequest: null });
		},
	);
	it("actual admission consumes the claim and refuses a removed approval rule", async () => {
		const f = await fixture(),
			operationId = randomUUID();
		await f.approve();
		await expect(f.claim(operationId)).resolves.toMatchObject({
			kind: "permit",
		});
		const operation = {
			id: operationId,
			connectionId: f.connection,
			method: "tools/call",
			target: "create_issue",
			approval: { id: f.pending.id, operationId },
		};
		await f.runtime.admit(operation);
		expect(
			(
				await backend.pool.query(
					"select status from tool_approvals where id=$1",
					[f.pending.id],
				)
			).rows[0].status,
		).toBe("consumed");
		const g = await fixture(),
			nextId = randomUUID();
		await g.approve();
		await g.claim(nextId);
		await backend.pool.query('update grants set rules=$2 where "agentId"=$1', [
			g.agent,
			JSON.stringify({ ...emptyRules(), full: true }),
		]);
		await expect(
			g.runtime.admit({
				...operation,
				id: nextId,
				connectionId: g.connection,
				approval: { id: g.pending.id, operationId: nextId },
			}),
		).rejects.toThrow();
		expect(
			(
				await backend.pool.query(
					"select status from tool_approvals where id=$1",
					[g.pending.id],
				)
			).rows[0].status,
		).toBe("invalidated");
	});
});
