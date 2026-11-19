import { randomUUID } from "node:crypto";
import {
	type AllAgentGrantClient,
	type ApprovalClient,
	createClient,
	type ManagementClient,
} from "@toolstile/api/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digest, issueToken } from "../packages/auth/src/index";
import { emptyRules } from "../packages/gateway/src/index";

// The RPC link is an untyped proxy over every instance procedure; setup and operator
// procedures have no exported client type, and the test only needs them to refuse.
type Refusable = (input: unknown) => Promise<unknown>;
type InstanceClient = ManagementClient &
	AllAgentGrantClient &
	ApprovalClient &
	Record<
		"saveSetup" | "verifySetup" | "suspendUser" | "operatorDeleteUser",
		Refusable
	>;

describe.skipIf(!process.env.TEST_BASE_URL)(
	"every ID-taking procedure refuses another user's records",
	() => {
		const base = process.env.TEST_BASE_URL ?? "";
		let runtime: typeof import("../apps/web/src/server/runtime");
		async function signIn() {
			const email = `${randomUUID()}@test.invalid`,
				token = issueToken();
			await runtime.pool.query(
				'insert into invitations(id,email,"expiresAt") values($1,$2,$3)',
				[digest(token), email, new Date(Date.now() + 60000)],
			);
			const response = await fetch(`${base}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: base },
				body: JSON.stringify({
					email,
					name: "Isolation user",
					password: "Local-test-password-12345",
					invitationToken: token,
				}),
			});
			expect(response.status).toBe(200);
			const cookie = response.headers
				.getSetCookie()
				.map((c) => c.split(";")[0])
				.join("; ");
			const {
				rows: [user],
			} = await runtime.pool.query('select id from "user" where email=$1', [
				email,
			]);
			const client = createClient(`${base}/api/rpc`, () => ({
				cookie,
				origin: base,
			})) as unknown as InstanceClient;
			return { id: user.id as string, client };
		}
		async function resources(api: InstanceClient, label: string) {
			const connection = await api.addConnection({
				label: `${label} connection`,
				url: "http://127.0.0.1:9/mcp",
				transport: "http",
				authentication: "headers",
				headers: {},
			});
			const device = await api.addDevice({ label: `${label} device` });
			const agent = await api.addAgent({
				label: `${label} agent`,
				deviceId: device.id,
				expiresInDays: 90,
			});
			const rules = { ...emptyRules(), full: true };
			await api.saveGrant({
				agentId: agent.id,
				connectionId: connection.id,
				rules,
			});
			return {
				connection: connection.id,
				device: device.id,
				agent: agent.id,
				rules,
			};
		}
		let owner: Awaited<ReturnType<typeof signIn>>,
			intruder: Awaited<ReturnType<typeof signIn>>,
			mine: Awaited<ReturnType<typeof resources>>,
			theirs: Awaited<ReturnType<typeof resources>>;
		const ids = { debug: "", payload: "", approval: "" };
		beforeAll(async () => {
			runtime = await import("../apps/web/src/server/runtime");
			owner = await signIn();
			intruder = await signIn();
			mine = await resources(owner.client, "Owner");
			theirs = await resources(intruder.client, "Intruder");
			await owner.client.saveAllAgentGrant({
				connectionId: mine.connection,
				rules: mine.rules,
			});
			ids.debug = (
				await owner.client.startDebug({
					agentIds: [mine.agent],
					connectionIds: [mine.connection],
				})
			).id;
			ids.payload = randomUUID();
			await runtime.pool.query(
				`insert into debug_payloads(id,"scopeId","sessionId","agentId","connectionId","encryptedPayload","expiresAt") values($1,$2,$3,$4,$5,'fixture',now() + (3600000) * interval '1 millisecond')`,
				[ids.payload, owner.id, ids.debug, mine.agent, mine.connection],
			);
			ids.approval = randomUUID();
			await runtime.pool.query(
				`insert into tool_approvals(id,"scopeId","requesterId","agentId","connectionId","connectionLabel","agentLabel",tool,fingerprint,"expiresAt") values($1,$2,$2,$3,$4,'Owner connection','Owner agent','echo',$5,now() + (3600000) * interval '1 millisecond')`,
				[ids.approval, owner.id, mine.agent, mine.connection, randomUUID()],
			);
		});
		afterAll(async () => {
			await runtime?.pool.end();
		});

		const cases: [string, (api: InstanceClient) => Promise<unknown>][] = [
			[
				"saveGrant",
				(api) =>
					api.saveGrant({
						agentId: mine.agent,
						connectionId: mine.connection,
						rules: mine.rules,
					}),
			],
			[
				"saveGrant with own agent",
				(api) =>
					api.saveGrant({
						agentId: theirs.agent,
						connectionId: mine.connection,
						rules: mine.rules,
					}),
			],
			[
				"saveGrant with own connection",
				(api) =>
					api.saveGrant({
						agentId: mine.agent,
						connectionId: theirs.connection,
						rules: mine.rules,
					}),
			],
			[
				"saveAllAgentGrant",
				(api) =>
					api.saveAllAgentGrant({
						connectionId: mine.connection,
						rules: mine.rules,
					}),
			],
			["verify", (api) => api.verify({ id: mine.connection })],
			[
				"startConnectionOAuth",
				(api) => api.startConnectionOAuth({ id: mine.connection }),
			],
			[
				"agentCatalog",
				(api) =>
					api.agentCatalog({
						agentId: mine.agent,
						connectionId: mine.connection,
					}),
			],
			[
				"agentCatalog with own agent",
				(api) =>
					api.agentCatalog({
						agentId: theirs.agent,
						connectionId: mine.connection,
					}),
			],
			[
				"testTool",
				(api) =>
					api.testTool({
						agentId: mine.agent,
						connectionId: mine.connection,
						name: "echo",
						arguments: {},
					}),
			],
			[
				"addAgent",
				(api) =>
					api.addAgent({
						label: "Stolen",
						deviceId: mine.device,
						expiresInDays: 90,
					}),
			],
			[
				"renameDevice",
				(api) => api.renameDevice({ id: mine.device, label: "Stolen" }),
			],
			[
				"renameAgent",
				(api) => api.renameAgent({ id: mine.agent, label: "Stolen" }),
			],
			["revokeAgent", (api) => api.revokeAgent({ id: mine.agent })],
			["revokeDevice", (api) => api.revokeDevice({ id: mine.device })],
			[
				"removeConnection",
				(api) => api.removeConnection({ id: mine.connection }),
			],
			[
				"startDebug",
				(api) =>
					api.startDebug({
						agentIds: [mine.agent],
						connectionIds: [mine.connection],
					}),
			],
			["extendDebug", (api) => api.extendDebug({ id: ids.debug })],
			["stopDebug", (api) => api.stopDebug({ id: ids.debug })],
			["debugPayload", (api) => api.debugPayload({ id: ids.payload })],
			["approvalDetail", (api) => api.approvalDetail({ id: ids.approval })],
			[
				"decideApproval",
				(api) => api.decideApproval({ id: ids.approval, decision: "approve" }),
			],
			[
				"saveSetup",
				(api) =>
					api.saveSetup({
						connectionId: mine.connection,
						agentId: mine.agent,
						client: "claude-code",
						step: "access",
						action: "save",
					}),
			],
			[
				"verifySetup",
				(api) =>
					api.verifySetup({
						connectionId: mine.connection,
						agentId: mine.agent,
					}),
			],
			[
				"suspendUser",
				(api) => api.suspendUser({ id: owner.id, suspended: true }),
			],
			[
				"operatorDeleteUser",
				(api) =>
					api.operatorDeleteUser({ id: owner.id, confirmation: "DELETE" }),
			],
		];
		it.each(cases)("%s refuses another user's IDs", async (_, call) => {
			await expect(call(intruder.client)).rejects.toThrow();
		});

		it("reads a linked activity row only for its owner, within retention", async () => {
			const prefix = `linked-${randomUUID()}-`,
				oldest = `${prefix}oldest`,
				expired = `${prefix}expired`;
			await runtime.pool.query(
				`insert into activity(id,"ownerId",agent,connection,method,target,outcome,"durationMs","createdAt") select $2 || i,$1,'Owner agent','Owner connection','tools/call','echo','forwarded',i,now() - i * interval '1 minute' from generate_series(1,100) i`,
				[owner.id, prefix],
			);
			await runtime.pool.query(
				`insert into activity(id,"ownerId",agent,connection,method,target,outcome,"durationMs","createdAt") values($1,$3,'Owner agent','Owner connection','tools/call','echo','forwarded',7,now() - interval '200 minutes'),($2,$3,'Owner agent','Owner connection','tools/call','echo','forwarded',7,now() - interval '400 days')`,
				[oldest, expired, owner.id],
			);
			const snapshot = await owner.client.snapshot();
			expect(snapshot.activity.some((entry) => entry.id === oldest)).toBe(
				false,
			);
			// Outside the newest 100, in the same shape as a snapshot row.
			expect(await owner.client.activityRequest({ id: oldest })).toEqual({
				id: oldest,
				agent: "Owner agent",
				connection: "Owner connection",
				origin: "agent",
				method: "tools/call",
				target: "echo",
				outcome: "forwarded",
				durationMs: 7,
				createdAt: expect.any(String),
			});
			// Another user's row, an expired row and an unknown id read alike.
			expect(await intruder.client.activityRequest({ id: oldest })).toBeNull();
			expect(await owner.client.activityRequest({ id: expired })).toBeNull();
			expect(
				await owner.client.activityRequest({ id: `${prefix}unknown` }),
			).toBeNull();
		});

		it("leaves the owner's records unchanged", async () => {
			const snapshot = await owner.client.snapshot();
			expect(snapshot.devices.find((d) => d.id === mine.device)).toMatchObject({
				label: "Owner device",
				revoked: false,
			});
			expect(snapshot.agents.find((a) => a.id === mine.agent)).toMatchObject({
				label: "Owner agent",
				revoked: false,
			});
			expect(snapshot.connections.some((c) => c.id === mine.connection)).toBe(
				true,
			);
			expect(snapshot.grants).toEqual([
				expect.objectContaining({
					agentId: mine.agent,
					connectionId: mine.connection,
				}),
			]);
			expect(snapshot.allAgentGrants?.map((g) => g.connectionId)).toEqual([
				mine.connection,
			]);
			const debug = await owner.client.debugStatus();
			expect(
				debug.sessions.find((s) => s.id === ids.debug)?.stoppedAt,
			).toBeNull();
			// Read the row directly: the fixture has no live binding, so the owner's own
			// detail view would invalidate it.
			expect(
				(
					await runtime.pool.query(
						'select status,"decidedBy" from tool_approvals where id=$1',
						[ids.approval],
					)
				).rows,
			).toEqual([{ status: "pending", decidedBy: null }]);
			const intruderView = await intruder.client.snapshot();
			expect(JSON.stringify(intruderView)).not.toContain(mine.connection);
			expect(intruderView.grants).toEqual([
				expect.objectContaining({
					agentId: theirs.agent,
					connectionId: theirs.connection,
				}),
			]);
		});
	},
);
