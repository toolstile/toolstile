import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstanceDebug } from "../apps/web/src/server/debug";
import type { DebugSelection } from "../packages/api/src/contract";
import { secretBox } from "../packages/auth/src/index";
import { createAccountTestDatabase } from "./account-database";
import { defined } from "./assertions";

// Migrations and expiry checks use an isolated real PostgreSQL database.
describe.skipIf(!process.env.TEST_BASE_URL)(
	"PostgreSQL encrypted capture lifecycle",
	() => {
		let database: Awaited<ReturnType<typeof createAccountTestDatabase>>;
		let debug: ReturnType<typeof createInstanceDebug>;
		const owner = randomUUID(),
			other = randomUUID(),
			operator = randomUUID(),
			agent = randomUUID(),
			connection = randomUUID();
		const actor = { userId: owner, scopeId: owner };
		let active = true;
		const box = secretBox("b".repeat(64));
		beforeAll(async () => {
			database = await createAccountTestDatabase();
			for (const id of [owner, other, operator])
				await database.pool.query(
					'insert into "user"(id,name,email) values($1,$1,$2)',
					[id, `${id}@test.invalid`],
				);
			debug = createInstanceDebug({
				pool: database.pool,
				box,
				async active(userId) {
					if (!active && userId === owner) throw new Error("inactive");
				},
				async ownAgent(who, id) {
					if (who.userId !== owner || id !== agent)
						throw new Error("Agent ownership denied");
				},
				async ownConnection(who, id) {
					if (who.userId !== owner || id !== connection)
						throw new Error("MCP ownership denied");
				},
			});
		});
		afterAll(async () => {
			await database.close();
		});
		const selection: DebugSelection = {
			agentIds: [agent],
			connectionIds: [connection],
		};
		function operation() {
			return {
				id: randomUUID(),
				connectionId: connection,
				method: "tools/call",
				target: "fixture",
			};
		}
		async function count() {
			return (
				await database.pool.query("select count(*) as n from debug_payloads")
			).rows[0].n;
		}
		it("captures nothing by default and requires selected owned agents and MCPs", async () => {
			expect(
				await debug.hook(actor, agent, async () => {})(operation()),
			).toBeUndefined();
			expect(await count()).toBe(0);
			await expect(
				debug.start(actor, { ...selection, agentIds: ["foreign"] }),
			).rejects.toThrow("ownership");
			await expect(
				debug.start(actor, { ...selection, connectionIds: ["foreign"] }),
			).rejects.toThrow("ownership");
			const session = await debug.start(actor, selection);
			const status = await debug.status(actor);
			expect(status.sessions[0].id).toBe(session.id);
			expect(
				Date.parse(status.sessions[0].stopsAt) - Date.now(),
			).toBeGreaterThan(3590000);
			expect(
				await debug.hook(actor, "other-agent", async () => {})(operation()),
			).toBeUndefined();
			expect(
				await debug.hook(actor, agent, async () => {})({
					...operation(),
					connectionId: "foreign",
				}),
			).toBeUndefined();
		});
		it("stores only ciphertext, deduplicates, bounds data, and hides other users' captures including operators", async () => {
			const op = operation();
			const save = await debug.hook(actor, agent, async () => {})(op);
			expect(save).toBeTypeOf("function");
			await defined(save)({
				arguments: {
					message: "selected-private-content",
					headers: { Authorization: "header-secret" },
				},
				result: {
					text: "result-private-content",
					access_token: "oauth-secret",
				},
			});
			await defined(save)({ arguments: { message: "duplicate" }, result: {} });
			const {
				rows: [stored],
			} = await database.pool.query(
				"select * from debug_payloads where id=$1",
				[op.id],
			);
			expect(stored.encryptedPayload).not.toContain("private-content");
			expect(stored.encryptedPayload).not.toContain("oauth-secret");
			expect(
				Math.abs(
					stored.expiresAt.getTime() - stored.createdAt.getTime() - 86400000,
				),
			).toBeLessThan(20);
			expect(await count()).toBe(1);
			const payload = await debug.payload(actor, op.id);
			expect(payload.arguments).toMatchObject({
				message: "selected-private-content",
				headers: "[redacted]",
			});
			await expect(
				debug.payload({ userId: other, scopeId: other }, op.id),
			).rejects.toThrow();
			await expect(
				debug.payload({ userId: operator, scopeId: owner }, op.id),
			).rejects.toThrow();
			await expect(
				debug.start({ userId: operator, scopeId: owner }, selection),
			).rejects.toThrow();
		});
		it("auto-stops at one hour, requires explicit extension while live, and respects explicit stop in flight", async () => {
			const { id } = await debug.start(actor, selection);
			const save = await debug.hook(actor, agent, async () => {})(operation());
			await debug.stop(actor, id);
			await expect(
				defined(save)({ arguments: {}, result: {} }),
			).rejects.toThrow();
			await expect(debug.extend(actor, id)).rejects.toThrow();
			const second = await debug.start(actor, selection);
			await database.pool.query(
				"update debug_sessions set \"stopsAt\"=now() + (120000) * interval '1 millisecond' where id=$1",
				[second.id],
			);
			await debug.extend(actor, second.id);
			expect(
				Date.parse((await debug.status(actor)).sessions[0].stopsAt) -
					Date.now(),
			).toBeGreaterThan(3590000);
			await database.pool.query(
				"update debug_sessions set \"stopsAt\"=now() - (1000) * interval '1 millisecond' where id=$1",
				[second.id],
			);
			expect(
				await debug.hook(actor, agent, async () => {})(operation()),
			).toBeUndefined();
			await expect(debug.extend(actor, second.id)).rejects.toThrow();
		});
		it("checks current capture authority and live agent authorization again before storage", async () => {
			await debug.start(actor, selection);
			const op = operation();
			let authorized = true;
			const save = await debug.hook(actor, agent, async () => {
				if (!authorized) throw new Error("revoked");
			})(op);
			authorized = false;
			await expect(
				defined(save)({ arguments: {}, result: {} }),
			).rejects.toThrow("revoked");
			const save2 = await debug.hook(actor, agent, async () => {})(op);
			active = false;
			await expect(
				defined(save2)({ arguments: {}, result: {} }),
			).rejects.toThrow("inactive");
			active = true;
			expect(
				(
					await database.pool.query(
						"select id from debug_payloads where id=$1",
						[op.id],
					)
				).rowCount,
			).toBe(0);
		});
		it("denies expired payload reads immediately and cleans up payloads and metadata at operator retention", async () => {
			await database.pool.query(
				"update debug_payloads set \"expiresAt\"=now() - (1000) * interval '1 millisecond'",
			);
			const {
				rows: [old],
			} = await database.pool.query("select id from debug_payloads limit 1");
			await expect(debug.payload(actor, old.id)).rejects.toThrow();
			await database.pool.query(
				"insert into activity(id,\"ownerId\",agent,connection,method,outcome,\"durationMs\",\"createdAt\") values($1,$2,'fixture','fixture','tools/call','forwarded',1,now() - interval '3 days'),($3,$2,'fixture','fixture','tools/call','forwarded',1,now())",
				[randomUUID(), owner, randomUUID()],
			);
			await database.pool.query(
				'insert into instance_settings(id,"activityRetentionDays","payloadRetentionHours") values(\'instance\',2,1) on conflict(id) do update set "activityRetentionDays"=2,"payloadRetentionHours"=1',
			);
			await debug.cleanup();
			expect(await count()).toBe(0);
			expect(
				(await database.pool.query("select * from activity")).rowCount,
			).toBe(1);
			expect(await debug.status(actor)).toMatchObject({
				activityRetentionDays: 2,
				payloadRetentionHours: 1,
			});
			await debug.start(actor, selection);
			const op = operation();
			const save = await debug.hook(actor, agent, async () => {})(op);
			await defined(save)({ arguments: {}, result: {} });
			const {
				rows: [row],
			} = await database.pool.query(
				'select "expiresAt","createdAt" from debug_payloads where id=$1',
				[op.id],
			);
			expect(
				Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - 3600000),
			).toBeLessThan(20);
			await database.pool.query(
				"update debug_payloads set \"createdAt\"=now() - (7200000) * interval '1 millisecond' where id=$1",
				[op.id],
			);
			await expect(debug.payload(actor, op.id)).rejects.toThrow();
			expect((await debug.status(actor)).payloads).toEqual([]);
		});
		it("caps each session at 1,000 encrypted payloads", async () => {
			const { id } = await debug.start(actor, selection);
			await database.pool.query(
				'with recursive fixture(n) as (select 1 union all select n+1 from fixture where n<1000) insert into debug_payloads(id,"scopeId","sessionId","agentId","connectionId","encryptedPayload","expiresAt") select $1||n,$2,$3,$4,$5,$6,now() + (3600000) * interval \'1 millisecond\' from fixture',
				[
					randomUUID(),
					owner,
					id,
					agent,
					connection,
					box.encrypt({ arguments: {}, result: {}, truncated: false }),
				],
			);
			const op = operation();
			const save = await debug.hook(actor, agent, async () => {})(op);
			await defined(save)({
				arguments: { text: "over the session limit" },
				result: {},
			});
			expect(
				(
					await database.pool.query(
						'select count(*) as n from debug_payloads where "sessionId"=$1',
						[id],
					)
				).rows[0].n,
			).toBe(1000);
			expect(
				(
					await database.pool.query(
						"select id from debug_payloads where id=$1",
						[op.id],
					)
				).rowCount,
			).toBe(0);
		});
	},
);
