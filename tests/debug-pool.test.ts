import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultOperatorSettings } from "../apps/web/src/server/operator-schema";
import type { Actor } from "../packages/api/src/contract";
import { transaction } from "../packages/database/src/transaction";
import { emptyRules } from "../packages/gateway/src/index";
import { createAccountTestDatabase } from "./account-database";
import { defined } from "./assertions";

// A nested pool checkout fails quickly rather than leaving a hung test process.
describe.skipIf(!process.env.TEST_BASE_URL)(
	"single-executor security transactions on PostgreSQL",
	() => {
		let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
		let backend: typeof import("../apps/web/src/server/runtime");
		let actor: Actor, agentId: string, connectionId: string;
		async function person(operator = false) {
			const userId = randomUUID(),
				sessionId = randomUUID();
			await backend.pool.query(
				'insert into "user"(id,name,email)values($1,$1,$2)',
				[userId, `${userId}@test.invalid`],
			);
			await backend.pool.query(
				'insert into profiles("userId",operator)values($1,$2)',
				[userId, operator],
			);
			await backend.pool.query(
				'insert into session(id,token,"userId","expiresAt")values($1,$1,$2,now() + (3600000) * interval \'1 millisecond\')',
				[sessionId, userId],
			);
			return { userId, scopeId: userId, sessionId };
		}
		async function seedAgent(owner: Actor) {
			const deviceId = randomUUID(),
				id = randomUUID();
			await backend.pool.query(
				"insert into devices(id,\"ownerId\",label)values($1,$2,'Fixture')",
				[deviceId, owner.userId],
			);
			await backend.pool.query(
				'insert into agents(id,"ownerId","deviceId",label)values($1,$2,$3,\'Fixture\')',
				[id, owner.userId, deviceId],
			);
			await backend.pool.query(
				'insert into authorizations(id,"agentId","tokenHash")values($1,$2,$3)',
				[randomUUID(), id, randomUUID()],
			);
			return id;
		}
		beforeAll(async () => {
			storage = await createAccountTestDatabase();
			vi.stubEnv("DATABASE_URL", storage.url);
			vi.stubEnv("TOOLSTILE_TELEMETRY_URL", "");
			backend = await import("../apps/web/src/server/runtime");
			actor = await person(true);
			agentId = await seedAgent(actor);
			connectionId = randomUUID();
			await backend.pool.query(
				"insert into connections(id,\"ownerId\",label,url,\"encryptedHeaders\")values($1,$2,'Fixture','http://127.0.0.1:1/mcp','unused')",
				[connectionId, actor.userId],
			);
			const rules = emptyRules();
			rules.full = true;
			await backend.pool.query(
				'insert into grants(id,"agentId","connectionId",rules)values($1,$2,$3,$4)',
				[randomUUID(), agentId, connectionId, rules],
			);
		});
		afterAll(async () => {
			await backend?.pool.end();
			await storage?.close();
			vi.unstubAllEnvs();
		});
		it.each([1, 2, 10])(
			"finishes debug start/extend/capture and simultaneous operator settings/invites with pool max %i",
			async (max) => {
				const concurrency = Math.max(4, max * 2);
				const selection = {
					agentIds: [agentId],
					connectionIds: [connectionId],
				};
				await Promise.all(
					Array.from({ length: concurrency }, () =>
						backend.debug.start(actor, selection),
					),
				);
				const current = defined(
					(await backend.debug.status(actor)).sessions.find(
						(session) => !session.stoppedAt,
					),
				);
				await Promise.all(
					Array.from({ length: concurrency }, () =>
						backend.debug.extend(actor, current.id),
					),
				);
				const saves = await Promise.all(
					Array.from({ length: concurrency }, () =>
						backend.debug.hook(actor, agentId, (executor, operation) =>
							backend.debug.checkAgent(actor, agentId, executor, operation),
						)({
							id: randomUUID(),
							connectionId,
							method: "tools/call",
							target: "read",
						}),
					),
				);
				expect(saves.every((save) => typeof save === "function")).toBe(true);
				await Promise.all(
					saves.map((save) =>
						defined(save)({
							arguments: { text: "synthetic payload" },
							result: { ok: true },
						}),
					),
				);
				const {
					rows: [count],
				} = await backend.pool.query(
					'select count(*) as n from debug_payloads where "sessionId"=$1',
					[current.id],
				);
				expect(count.n).toBe(concurrency);
				await Promise.all(
					Array.from({ length: concurrency }, async () => {
						await backend.operatorService.saveSettings(
							actor,
							defaultOperatorSettings,
						);
						const invite = await backend.operatorService.invite(actor, {
							email: `${randomUUID()}@test.invalid`,
						});
						expect(invite.url).toContain("accept-invitation");
						expect(await backend.operatorService.settings(actor)).toMatchObject(
							defaultOperatorSettings,
						);
					}),
				);
				const target = await person();
				await Promise.all([
					backend.operatorService.suspend(actor, target.userId, true),
					backend.operatorService.saveSettings(actor, defaultOperatorSettings),
					backend.operatorService.invite(actor, {}),
				]);
				await backend.operatorService.deleteUser(actor, target.userId);
				expect(
					(
						await backend.pool.query(
							'select "deletedAt" from profiles where "userId"=$1',
							[target.userId],
						)
					).rows[0].deletedAt,
				).not.toBeNull();
			},
			15000,
		);
		it("commits self deletion as one plan and preserves last-operator protection", async () => {
			const target = await person();
			const result = await backend.services.deleteAccount(target);
			expect(result.purgeAfter).toBeTypeOf("string");
			expect(
				(
					await backend.pool.query('select id from session where "userId"=$1', [
						target.userId,
					])
				).rowCount,
			).toBe(0);
			expect(
				(
					await backend.pool.query(
						'select action from account_audit where "subjectId"=$1',
						[target.userId],
					)
				).rows.map((row) => row.action),
			).toContain("account-deletion-requested");
			await expect(backend.services.deleteAccount(actor)).rejects.toThrow(
				"last active operator",
			);
		});
		it("rolls caller-owned account revocation and audit back atomically", async () => {
			const target = await person(),
				id = await seedAgent(target);
			await expect(
				transaction(backend.pool, async (tx) => {
					await backend.accounts.suspend(
						target.userId,
						actor.userId,
						true,
						tx,
					);
					throw new Error(
						"fixture refusal after revocation and audit preparation",
					);
				}),
			).rejects.toThrow("fixture refusal");
			const {
				rows: [profile],
			} = await backend.pool.query(
				'select suspended,"deletedAt" from profiles where "userId"=$1',
				[target.userId],
			);
			expect(profile).toMatchObject({ suspended: false, deletedAt: null });
			expect(
				(
					await backend.pool.query('select id from session where "userId"=$1', [
						target.userId,
					])
				).rowCount,
			).toBe(1);
			expect(
				(
					await backend.pool.query(
						'select "revokedAt" from authorizations where "agentId"=$1',
						[id],
					)
				).rows[0].revokedAt,
			).toBeNull();
			expect(
				(
					await backend.pool.query(
						'select id from account_audit where "subjectId"=$1',
						[target.userId],
					)
				).rowCount,
			).toBe(0);
		});
	},
);
