import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createORPCClient,
	type RouterClient,
	RPCHandler,
	RPCLink,
} from "../apps/web/test-support/setup-rpc";
import type { ApprovalRow } from "../packages/api/src/approval-server";
import {
	APPROVAL_PENDING_LIMIT,
	ApprovalLimitError,
	createApprovalRouter,
	createApprovalStore,
} from "../packages/api/src/approval-server";
import { secretBox } from "../packages/auth/src/index";
import type { Pool } from "../packages/database/src/sql";
import { transaction } from "../packages/database/src/transaction";
import {
	type ApprovalParameters,
	approvalRequest,
	emptyRules,
	type Upstream,
} from "../packages/gateway/src/index";
import { createAccountTestDatabase } from "./account-database";

// The generic store runs against a disposable PostgreSQL database with a host-shaped table.
describe.skipIf(!process.env.TEST_BASE_URL)("PostgreSQL approval store", () => {
	let database: Awaited<ReturnType<typeof createAccountTestDatabase>>;
	let single: Pool;
	const box = secretBox("b".repeat(64));
	const scope = randomUUID(),
		otherScope = randomUUID(),
		reviewer = randomUUID(),
		requester = randomUUID(),
		agent = randomUUID();
	const reviewerActor = { userId: reviewer, scopeId: scope, sessionId: "s" };
	const requesterActor = { userId: requester, scopeId: scope, sessionId: "s" };
	const live: {
		upstream: Upstream;
		reviewers: Set<string>;
	} = {
		upstream: {
			id: "connection-1",
			label: "Tracker",
			url: "https://tracker.example/mcp",
			transport: "http",
			headers: {},
			identityKey: "grant-1",
			rules: [{ ...emptyRules(), requireApproval: ["create_issue"] }],
		},
		reviewers: new Set([reviewer]),
	};
	const executors = new Set<unknown>();
	let validationDelay = 0;
	function store(pool: Pool) {
		return createApprovalStore({
			pool,
			table: "approval_fixture",
			box,
			secret: "b".repeat(64),
			// A shared fence that a fixture configuration writer could hold exclusively.
			fences: (scopeId) => [
				{ rank: 1, key: `fixture-scope:${scopeId}`, shared: true },
			],
			async canReview(executor, actor) {
				// Callbacks must use the supplied executor, never reacquire the pool.
				executors.add(executor);
				await executor.query("select 1");
				return live.reviewers.has(actor.userId);
			},
			async validate(executor, row, parameters) {
				await executor.query("select 1");
				// A slow binding check, as when the host rebuilds accounts and rules.
				if (validationDelay)
					await new Promise((resolve) => setTimeout(resolve, validationDelay));
				if (row.decidedBy && !live.reviewers.has(row.decidedBy)) return false;
				return approvalRequest(live.upstream, parameters);
			},
			async reviewUrl(row, executor) {
				await executor.query("select 1");
				return `/app/approvals?approvalId=${row.id}`;
			},
		});
	}
	let approvals: ReturnType<typeof store>;
	const privateTitle = "Private issue title for approval encryption";
	const parameters = (title = privateTitle): ApprovalParameters => ({
		name: "create_issue",
		arguments: { title },
	});
	const request = (title?: string) =>
		approvalRequest(live.upstream, parameters(title));
	const runtime = (agentId = agent) =>
		approvals.runtime({
			scopeId: scope,
			requesterId: requester,
			agentId,
			agentLabel: "Laptop agent",
		});
	async function row(id: string) {
		const {
			rows: [found],
		} = await database.pool.query<ApprovalRow>(
			"select * from approval_fixture where id = $1",
			[id],
		);
		return found;
	}
	beforeAll(async () => {
		database = await createAccountTestDatabase();
		// Same columns and indexes as the host table, without host foreign keys.
		await database.pool.query(
			"CREATE TABLE approval_fixture (LIKE tool_approvals INCLUDING DEFAULTS INCLUDING INDEXES)",
		);
		await database.pool.query(
			"CREATE UNIQUE INDEX approval_fixture_active ON approval_fixture(\"scopeId\",\"agentId\",fingerprint) WHERE status IN ('pending','approved','claimed')",
		);
		single = database.pool;
		approvals = store(database.pool);
	});
	afterAll(async () => {
		await single?.end();
		await database?.close();
	});
	it("creates one encrypted, keyed pending request per exact call", async () => {
		const first = await runtime().begin(request(), "op-1");
		expect(first).toMatchObject({
			kind: "pending",
			reviewUrl: expect.stringContaining("approvalId="),
		});
		const again = await runtime().begin(request(), "op-2");
		expect(again).toMatchObject({ kind: "pending", id: first.id });
		const stored = await row(first.id);
		expect(stored.encryptedRequest).not.toContain(privateTitle);
		expect(JSON.stringify(stored)).not.toContain(privateTitle);
		// Fingerprints are keyed: a plain digest of the binding cannot be matched.
		expect(stored.fingerprint).not.toBe(
			createHash("sha256").update(request().binding).digest("base64url"),
		);
		const detail = await approvals.services.approvalDetail(
			reviewerActor,
			first.id,
		);
		expect(detail.parameters).toEqual(parameters());
		expect(detail.canDecide).toBe(true);
		const own = await approvals.services.approvalDetail(
			requesterActor,
			first.id,
		);
		expect(own.parameters).toBeUndefined();
		expect(own.canDecide).toBe(false);
		await expect(
			approvals.services.approvalDetail(
				{ ...reviewerActor, scopeId: otherScope },
				first.id,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("claims an approval once, consumes it and clears the payload", async () => {
		const pending = await runtime().begin(request("Claim"), "op-1");
		await expect(
			approvals.services.decideApproval(requesterActor, {
				id: pending.id,
				decision: "approve",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await approvals.services.decideApproval(reviewerActor, {
			id: pending.id,
			decision: "approve",
		});
		const approved = await row(pending.id);
		expect(approved.status).toBe("approved");
		expect(approved.expiresAt.getTime()).toBeLessThanOrEqual(
			Date.now() + 10 * 60000 + 5000,
		);
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				runtime().begin(request("Claim"), `race-${index}`),
			),
		);
		const permits = results.filter((result) => result.kind === "permit");
		expect(permits).toHaveLength(1);
		// A held permit blocks fresh pending requests rather than racing release.
		expect(results.filter((result) => result.kind === "busy")).toHaveLength(5);
		const winner = results.findIndex((result) => result.kind === "permit");
		await expect(
			runtime().settle(pending.id, "not-the-claimer", "consumed"),
		).rejects.toThrow(/no longer available/);
		expect((await row(pending.id)).status).toBe("claimed");
		await runtime().settle(pending.id, `race-${winner}`, "consumed");
		const consumed = await row(pending.id);
		expect(consumed).toMatchObject({
			status: "consumed",
			encryptedRequest: null,
		});
		const next = await runtime().begin(request("Claim"), "op-9");
		expect(next).toMatchObject({ kind: "pending" });
		expect(next.id).not.toBe(pending.id);
	});
	it("returns a claimed permit after a known pre-forward refusal", async () => {
		const pending = await runtime().begin(request("Release"), "op-1");
		await approvals.services.decideApproval(reviewerActor, {
			id: pending.id,
			decision: "approve",
		});
		const permit = await runtime().begin(request("Release"), "op-2");
		expect(permit.kind).toBe("permit");
		await runtime().release(pending.id, "op-other");
		expect((await row(pending.id)).status).toBe("claimed");
		await runtime().release(pending.id, "op-2");
		const released = await row(pending.id);
		expect(released.status).toBe("approved");
		expect(released.encryptedRequest).not.toBeNull();
		expect((await runtime().begin(request("Release"), "op-3")).kind).toBe(
			"permit",
		);
	});
	async function approvedClaim(title: string, operationId: string) {
		const pending = await runtime().begin(request(title), "op-request");
		await approvals.services.decideApproval(reviewerActor, {
			id: pending.id,
			decision: "approve",
		});
		expect((await runtime().begin(request(title), operationId)).kind).toBe(
			"permit",
		);
		return pending.id;
	}
	const requesterBinding = {
		scopeId: scope,
		requesterId: requester,
		agentId: agent,
		agentLabel: "Laptop agent",
	};
	it("consumes the exact claim inside the host admission transaction", async () => {
		const id = await approvedClaim("Consume", "op-c");
		await expect(
			transaction(database.pool, async (tx) => {
				await approvals.consume(requesterBinding, id, "op-c", tx);
				throw new Error("fixture admission refused");
			}),
		).rejects.toThrow("fixture admission refused");
		expect((await row(id)).status).toBe("claimed");
		await expect(
			transaction(database.pool, (tx) =>
				approvals.consume(requesterBinding, id, "op-other", tx),
			),
		).rejects.toThrow(/no longer available/);
		await transaction(database.pool, (tx) =>
			approvals.consume(requesterBinding, id, "op-c", tx),
		);
		expect(await row(id)).toMatchObject({
			status: "consumed",
			encryptedRequest: null,
		});
		// The gateway's own settlement after admission is idempotent for the same operation.
		await runtime().settle(id, "op-c", "consumed");
		await expect(runtime().settle(id, "op-other", "consumed")).rejects.toThrow(
			/no longer available/,
		);
		// Release after consumption never restores the approval.
		await runtime().release(id, "op-c");
		expect((await row(id)).status).toBe("consumed");
	});
	it("checks expiry against wall clock inside an older admission transaction", async () => {
		const id = await approvedClaim("Wall clock expiry", "op-clock");
		await database.pool.query(
			`update approval_fixture set "expiresAt"=now() + (100) * interval '1 millisecond' where id=$1`,
			[id],
		);
		// Validity is required at consumption, judged by the wall clock then, not when the
		// transaction began; hosts consume as the last step before commit (final admission),
		// and the refused admission rolls back completely.
		await expect(
			transaction(database.pool, async (tx) => {
				await tx.query("select 1");
				await new Promise((resolve) => setTimeout(resolve, 200));
				await approvals.consume(requesterBinding, id, "op-clock", tx);
			}),
		).rejects.toThrow(/no longer available/);
		expect((await row(id)).status).toBe("claimed");
		await runtime().release(id, "op-clock");
		expect(await row(id)).toMatchObject({
			status: "expired",
			encryptedRequest: null,
		});
	});
	it("judges expiry after waiting for the claim's row lock, not before", async () => {
		const id = await approvedClaim("Expiry during lock wait", "op-wait");
		await database.pool.query(
			`update approval_fixture set "expiresAt"=clock_timestamp() + (150) * interval '1 millisecond' where id=$1`,
			[id],
		);
		// Another transaction holds the claim row past its deadline.
		const holder = await database.pool.connect();
		await holder.query("BEGIN");
		await holder.query(
			"select id from approval_fixture where id=$1 for update",
			[id],
		);
		const settled = Promise.allSettled([
			runtime().settle(id, "op-wait", "consumed"),
		]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await holder.query("COMMIT");
		holder.release();
		const [outcome] = await settled;
		expect(outcome).toMatchObject({
			status: "rejected",
			reason: { message: expect.stringMatching(/no longer available/) },
		});
		expect(await row(id)).toMatchObject({
			status: "expired",
			encryptedRequest: null,
		});
	});
	it("does not consume a claim that lapsed while its binding was validated", async () => {
		const id = await approvedClaim("Expiry during validation", "op-slow");
		await database.pool.query(
			`update approval_fixture set "expiresAt"=clock_timestamp() + (150) * interval '1 millisecond' where id=$1`,
			[id],
		);
		validationDelay = 300;
		try {
			await expect(
				runtime().settle(id, "op-slow", "consumed"),
			).rejects.toThrow(/no longer available/);
		} finally {
			validationDelay = 0;
		}
		expect(await row(id)).toMatchObject({
			status: "expired",
			encryptedRequest: null,
		});
	});
	it("refuses to consume a claim that expired or lost its binding", async () => {
		const expired = await approvedClaim("Lapse claim", "op-e");
		await database.pool.query(
			`update approval_fixture set "expiresAt" = now() - (1000) * interval '1 millisecond' where id = $1`,
			[expired],
		);
		await expect(runtime().settle(expired, "op-e", "consumed")).rejects.toThrow(
			/no longer available/,
		);
		// Time running out is reported as expiry, never as a changed binding.
		expect(await row(expired)).toMatchObject({
			status: "expired",
			encryptedRequest: null,
		});
		const swept = await approvedClaim("Swept claim", "op-s");
		await database.pool.query(
			`update approval_fixture set "expiresAt" = now() - (1000) * interval '1 millisecond' where id = $1`,
			[swept],
		);
		await approvals.cleanup(30);
		await expect(runtime().settle(swept, "op-s", "consumed")).rejects.toThrow(
			/no longer available/,
		);
		expect(await row(swept)).toMatchObject({
			status: "expired",
			encryptedRequest: null,
		});
		const original = live.upstream;
		const rebound = await approvedClaim("Rebound claim", "op-r");
		live.upstream = { ...original, identityKey: "grant-9" };
		try {
			await expect(
				runtime().settle(rebound, "op-r", "consumed"),
			).rejects.toThrow(/no longer available/);
		} finally {
			live.upstream = original;
		}
		expect((await row(rebound)).status).toBe("invalidated");
	});
	it("invalidates rather than releases a claim whose binding changed", async () => {
		const original = live.upstream;
		const id = await approvedClaim("Release rebound", "op-x");
		live.upstream = {
			...original,
			rules: [{ ...emptyRules(), requireApproval: ["create_issue", "new"] }],
		};
		try {
			await runtime().release(id, "op-x");
		} finally {
			live.upstream = original;
		}
		expect(await row(id)).toMatchObject({
			status: "invalidated",
			encryptedRequest: null,
		});
		await runtime().settle(id, "op-x", "invalidated");
		expect((await row(id)).status).toBe("invalidated");
	});
	it("remembers a denial without keeping the payload", async () => {
		const pending = await runtime().begin(request("Deny"), "op-1");
		await approvals.services.decideApproval(reviewerActor, {
			id: pending.id,
			decision: "deny",
		});
		expect(await row(pending.id)).toMatchObject({
			status: "denied",
			encryptedRequest: null,
			decidedBy: reviewer,
		});
		expect(await runtime().begin(request("Deny"), "op-2")).toMatchObject({
			kind: "denied",
			id: pending.id,
		});
		await expect(
			approvals.services.decideApproval(reviewerActor, {
				id: pending.id,
				decision: "approve",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("invalidates approvals whose account, rules or reviewer changed", async () => {
		const original = live.upstream;
		const pending = await runtime().begin(request("Rotate"), "op-1");
		live.upstream = { ...original, identityKey: "grant-2" };
		await expect(
			approvals.services.decideApproval(reviewerActor, {
				id: pending.id,
				decision: "approve",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// The invalidation committed even though the decision was refused.
		expect(await row(pending.id)).toMatchObject({
			status: "invalidated",
			encryptedRequest: null,
		});
		live.upstream = original;
		// Viewing an active request re-binds it first and never exposes a stale payload.
		const viewed = await runtime().begin(request("View"), "op-v");
		live.upstream = { ...original, identityKey: "grant-3" };
		const stale = await approvals.services.approvalDetail(
			reviewerActor,
			viewed.id,
		);
		expect(stale).toMatchObject({ status: "invalidated", canDecide: false });
		expect(stale.parameters).toBeUndefined();
		expect(await row(viewed.id)).toMatchObject({
			status: "invalidated",
			encryptedRequest: null,
		});
		live.upstream = original;
		const request2 = request("Rules");
		const second = await runtime().begin(request2, "op-2");
		await approvals.services.decideApproval(reviewerActor, {
			id: second.id,
			decision: "approve",
		});
		live.upstream = {
			...original,
			rules: [{ ...emptyRules(), requireApproval: ["create_issue", "x"] }],
		};
		// The claim-time live check rejects the stored binding even for an identical retry.
		const retried = await runtime().begin(request2, "op-3");
		expect(retried.kind).toBe("pending");
		expect((await row(second.id)).status).toBe("invalidated");
		live.upstream = original;
		const third = await runtime().begin(request("Reviewer"), "op-4");
		await approvals.services.decideApproval(reviewerActor, {
			id: third.id,
			decision: "approve",
		});
		live.reviewers.delete(reviewer);
		try {
			expect((await runtime().begin(request("Reviewer"), "op-5")).kind).toBe(
				"pending",
			);
			expect((await row(third.id)).status).toBe("invalidated");
		} finally {
			live.reviewers.add(reviewer);
		}
	});
	it("enforces expiry on reads and decisions", async () => {
		const pending = await runtime().begin(request("Expire"), "op-1");
		await database.pool.query(
			`update approval_fixture set "expiresAt" = now() - (1000) * interval '1 millisecond' where id = $1`,
			[pending.id],
		);
		await expect(
			approvals.services.decideApproval(reviewerActor, {
				id: pending.id,
				decision: "approve",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await row(pending.id)).toMatchObject({
			status: "expired",
			encryptedRequest: null,
		});
		const fresh = await runtime().begin(request("Expire"), "op-2");
		expect(fresh.kind).toBe("pending");
		expect(fresh.id).not.toBe(pending.id);
	});
	it("bounds pending requests per requester across agents", async () => {
		const bounded = randomUUID();
		const many = approvals.runtime({
			scopeId: bounded,
			requesterId: requester,
			agentId: "a",
			agentLabel: "A",
		});
		const other = approvals.runtime({
			scopeId: bounded,
			requesterId: requester,
			agentId: "b",
			agentLabel: "B",
		});
		for (let index = 0; index < APPROVAL_PENDING_LIMIT; index++)
			await (index % 2 ? many : other).begin(request(`n${index}`), "op");
		await expect(many.begin(request("over"), "op")).rejects.toBeInstanceOf(
			ApprovalLimitError,
		);
		await expect(other.begin(request("over"), "op")).rejects.toBeInstanceOf(
			ApprovalLimitError,
		);
	});
	it("lists by status and search, limited to the requester for non-reviewers", async () => {
		const listed = await approvals.services.listApprovals(reviewerActor, {
			status: "all",
			query: "create",
		});
		expect(listed.total).toBeGreaterThan(0);
		expect(
			listed.requests.every((entry) => entry.tool === "create_issue"),
		).toBe(true);
		expect(JSON.stringify(listed)).not.toContain(privateTitle);
		const history = await approvals.services.listApprovals(reviewerActor, {
			status: "history",
		});
		expect(
			history.requests.every((entry) =>
				["consumed", "denied", "expired", "invalidated"].includes(entry.status),
			),
		).toBe(true);
		const stranger = await approvals.services.listApprovals(
			{ userId: randomUUID(), scopeId: scope },
			{ status: "all" },
		);
		expect(stranger.total).toBe(0);
		const none = await approvals.services.listApprovals(reviewerActor, {
			query: "%",
		});
		expect(none.total).toBe(0);
	});
	it("does not deadlock with a single pooled connection", async () => {
		const narrow = store(single);
		const requesterRuntime = narrow.runtime({
			scopeId: scope,
			requesterId: requester,
			agentId: agent,
			agentLabel: "Laptop agent",
		});
		const pending = await requesterRuntime.begin(request("Single"), "op-1");
		await Promise.all([
			narrow.services.decideApproval(reviewerActor, {
				id: pending.id,
				decision: "approve",
			}),
			narrow.services.listApprovals(reviewerActor, {}),
			requesterRuntime.begin(request("Single 2"), "op-2"),
		]);
		expect((await requesterRuntime.begin(request("Single"), "op-3")).kind).toBe(
			"permit",
		);
		await requesterRuntime.settle(pending.id, "op-3", "consumed");
		expect(executors.size).toBeGreaterThan(0);
	});
	it("cleans up lapsed requests and old history", async () => {
		await expect(approvals.cleanup(0)).rejects.toThrow(/1 to 3650/);
		await expect(approvals.cleanup(1.5)).rejects.toThrow(/1 to 3650/);
		const old = await runtime().begin(request("Old"), "op-2");
		await approvals.services.decideApproval(reviewerActor, {
			id: old.id,
			decision: "deny",
		});
		const lapsed = await runtime().begin(request("Lapsed"), "op-1");
		await database.pool.query(
			`update approval_fixture set "expiresAt" = now() - (1000) * interval '1 millisecond' where id = $1`,
			[lapsed.id],
		);
		await database.pool.query(
			`update approval_fixture set "settledAt" = now() - (2678400000) * interval '1 millisecond' where id = $1`,
			[old.id],
		);
		const result = await approvals.cleanup(30);
		expect(result.expired).toBeGreaterThanOrEqual(1);
		expect(result.deleted).toBeGreaterThanOrEqual(1);
		expect(await row(lapsed.id)).toMatchObject({
			status: "expired",
			encryptedRequest: null,
		});
		expect(await row(old.id)).toBeUndefined();
		const {
			rows: [leftover],
		} =
			await database.pool.query(`select count(*) as count from approval_fixture
\t\t\twhere "encryptedRequest" is not null and status not in ('pending','approved','claimed')`);
		expect(leftover.count).toBe(0);
	});
	it("serves reviewer procedures only to dashboard sessions", async () => {
		const handler = new RPCHandler(createApprovalRouter());
		const createRouterClient = (
			_router: unknown,
			{
				context,
			}: {
				context: Record<string, unknown>;
			},
		) =>
			createORPCClient<RouterClient<ReturnType<typeof createApprovalRouter>>>(
				new RPCLink({
					url: "http://localhost/rpc",
					fetch: async (input, init) =>
						(
							await handler.handle(new Request(input, init), {
								prefix: "/rpc",
								context: context as never,
							})
						).response ?? new Response(null, { status: 404 }),
				}),
			);
		const router = undefined;
		for (const context of [
			{ actor: reviewerActor, services: approvals.services },
			{
				actor: reviewerActor,
				services: approvals.services,
				dashboardSession: false,
			},
			{
				actor: { userId: reviewer, scopeId: scope },
				services: approvals.services,
				dashboardSession: true,
			},
		])
			await expect(
				createRouterClient(router, { context }).listApprovals({}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		const client = createRouterClient(router, {
			context: {
				actor: reviewerActor,
				services: approvals.services,
				dashboardSession: true,
			},
		});
		await expect(
			client.listApprovals({ status: "all" }),
		).resolves.toMatchObject({
			total: expect.any(Number),
		});
	});
});
