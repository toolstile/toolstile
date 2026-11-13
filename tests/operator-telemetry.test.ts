import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccountService } from "../apps/web/src/server/accounts";
import {
	createInstanceDestinationPolicy,
	permittedAddress,
} from "../apps/web/src/server/network";
import {
	createOperatorRouter,
	createOperatorService,
} from "../apps/web/src/server/operator";
import { defaultOperatorSettings } from "../apps/web/src/server/operator-schema";
import {
	bucketCount,
	createTelemetryService,
	telemetryDestination,
	telemetryPayload,
} from "../apps/web/src/server/telemetry";
import type { Actor } from "../packages/api/src/contract";
import { createAccountTestDatabase } from "./account-database";

const rebinding = vi.hoisted(() => ({ preflight: 0, connected: 0 }));
vi.mock("node:dns/promises", async (original) => {
	const actual = await original<typeof import("node:dns/promises")>();
	return {
		...actual,
		lookup: async (hostname: string, options: unknown) => {
			if (hostname === "rebind.fixture.invalid") {
				rebinding.preflight++;
				return [{ address: "1.1.1.1", family: 4 }];
			}
			if (hostname === "rebind-public.fixture.invalid")
				return [{ address: "10.0.0.1", family: 4 }];
			return actual.lookup(
				hostname,
				options as import("node:dns").LookupAllOptions,
			);
		},
	};
});
vi.mock("node:dns", async (original) => {
	const actual = await original<typeof import("node:dns")>();
	return {
		...actual,
		lookup: (
			hostname: string,
			options: unknown,
			callback: (error: Error | null, addresses: unknown) => void,
		) => {
			if (hostname === "rebind.fixture.invalid") {
				rebinding.connected++;
				callback(null, [{ address: "127.0.0.1", family: 4 }]);
				return;
			}
			if (hostname === "rebind-public.fixture.invalid") {
				rebinding.connected++;
				callback(null, [{ address: "1.1.1.1", family: 4 }]);
				return;
			}
			return actual.lookup(
				hostname,
				options as import("node:dns").LookupAllOptions,
				callback as never,
			);
		},
	};
});
it("accepts only fixed noncontent telemetry fields and configured HTTPS destinations", () => {
	const counts = {
		users: "1-9",
		connections: "0",
		agents: "0",
		operations: "0",
		errors: "0",
	};
	expect(
		telemetryPayload.safeParse({ schemaVersion: 1, period: "day", counts })
			.success,
	).toBe(true);
	for (const extra of [
		{ email: "secret@test.invalid" },
		{ installationId: "stable" },
		{ url: "https://private.invalid" },
		{ date: "2026-10-19" },
	])
		expect(
			telemetryPayload.safeParse({
				schemaVersion: 1,
				period: "day",
				counts,
				...extra,
			}).success,
		).toBe(false);
	expect(
		telemetryPayload.safeParse({
			schemaVersion: 1,
			period: "day",
			counts: { ...counts, operations: 123 },
		}).success,
	).toBe(false);
	expect(
		[0, 1, 9, 10, 99, 100, 999, 1000, 9999, 10000, 1e12].map(bucketCount),
	).toEqual([
		"0",
		"1-9",
		"1-9",
		"10-99",
		"10-99",
		"100-999",
		"100-999",
		"1000-9999",
		"1000-9999",
		"10000+",
		"10000+",
	]);
	expect(telemetryDestination(undefined)).toBeUndefined();
	for (const url of [
		"http://host.invalid/collect",
		"https://u:p@host.invalid/",
		"https://host.invalid/?token=x",
		"https://host.invalid/#id",
	])
		expect(() => telemetryDestination(url)).toThrow();
});
it("classifies public, private, mapped and infrastructure addresses", () => {
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"::1",
		"fd00::1",
		"::ffff:192.168.1.1",
	]) {
		expect(permittedAddress(address, false)).toBe(false);
		expect(permittedAddress(address, true)).toBe(true);
	}
	for (const address of [
		"169.254.169.254",
		"0.0.0.0",
		"224.0.0.1",
		"fe80::1",
		"100.100.100.200",
	])
		expect(permittedAddress(address, true)).toBe(false);
	expect(permittedAddress("1.1.1.1", false)).toBe(true);
});
describe.skipIf(!process.env.TEST_BASE_URL)(
	"operator and anonymous telemetry PostgreSQL integration",
	() => {
		let database: Awaited<ReturnType<typeof createAccountTestDatabase>>;
		let operator: ReturnType<typeof createOperatorService>;
		let admin: Actor, regular: Actor, stale: Actor;
		const revoked = vi.fn(async (_id: string) => {});
		async function person(isOperator = false, old = false) {
			const id = randomUUID(),
				sessionId = randomUUID();
			await database.pool.query(
				'insert into "user"(id,name,email) values($1,$2,$3)',
				[id, "Private person's name", `${id}@test.invalid`],
			);
			await database.pool.query(
				'insert into profiles("userId",operator) values($1,$2)',
				[id, isOperator],
			);
			await database.pool.query(
				'insert into session(id,token,"userId","expiresAt","createdAt") values($1,$2,$3,now() + (86400000) * interval \'1 millisecond\',now() - $4::double precision * interval \'1 minute\')',
				[sessionId, randomUUID(), id, old ? 11 : 0],
			);
			return { userId: id, scopeId: id, sessionId };
		}
		beforeAll(async () => {
			database = await createAccountTestDatabase();
			operator = createOperatorService(database.pool, {
				accounts: createAccountService(database.pool),
				baseURL: "https://instance.invalid",
				revokeUserConnections: revoked,
			});
			admin = await person(true);
			regular = await person();
			stale = await person(true, true);
		});
		afterAll(async () => {
			await database?.close();
		});
		it("defaults invite-only and denies nonoperators, forged sessions and stale mutations", async () => {
			expect(await operator.settings(admin)).toEqual(defaultOperatorSettings);
			expect(
				await operator.canRegister("nobody@test.invalid", "", false, false),
			).toBe(false);
			await expect(operator.users(regular)).rejects.toThrow();
			await expect(
				operator.settings({ ...admin, sessionId: regular.sessionId }),
			).rejects.toThrow();
			await expect(operator.invite(stale, {})).rejects.toThrow("Sign in again");
			expect(await operator.settings(stale)).toEqual(defaultOperatorSettings);
			expect(Object.keys(createOperatorRouter(operator))).not.toContain(
				"emergencyReset",
			);
		});
		it("creates email-free/email-bound expiring invitations, rejects mismatches, consumes once and revokes", async () => {
			const result = await operator.invite(admin, { expiresInHours: 2 });
			const token = result.url.split("/").at(-1) ?? "";
			expect(new Date(result.expiresAt).getTime() - Date.now()).toBeGreaterThan(
				7100000,
			);
			const accounts = createAccountService(database.pool);
			const consumed = await Promise.all(
				Array.from({ length: 6 }, () =>
					accounts.consumeInvitation("free@users.invalid", token, false, false),
				),
			);
			expect(consumed.filter(Boolean)).toHaveLength(1);
			const bound = await operator.invite(admin, {
				email: "INVITED@test.invalid",
				expiresInHours: 1,
			});
			const boundToken = bound.url.split("/").at(-1) ?? "";
			expect(
				await operator.canRegister(
					"other@test.invalid",
					boundToken,
					true,
					true,
				),
			).toBe(false);
			expect(
				await operator.canRegister(
					"invited@test.invalid",
					boundToken,
					false,
					true,
				),
			).toBe(false);
			const invites = await operator.invitations(admin);
			expect(invites).toHaveLength(1);
			expect(JSON.stringify(invites)).not.toContain(boundToken);
			await operator.revokeInvitation(admin, invites[0].id);
			expect(
				await operator.canRegister(
					"invited@test.invalid",
					boundToken,
					true,
					true,
				),
			).toBe(false);
			await expect(
				operator.invite(admin, { expiresInHours: 169 }),
			).rejects.toThrow();
			const expired = await operator.invite(admin, {});
			await database.pool.query(
				"update invitations set \"expiresAt\"=now() - (1000) * interval '1 millisecond'",
			);
			expect(
				await operator.canRegister(
					"x@test.invalid",
					expired.url.split("/").at(-1) ?? "",
					false,
					false,
				),
			).toBe(false);
		});
		it("requires explicit open registration and preserves verified-social checks", async () => {
			await operator.saveSettings(admin, {
				...defaultOperatorSettings,
				registrationPolicy: "open",
			});
			expect(
				await operator.canRegister("new@test.invalid", "", false, false),
			).toBe(true);
			expect(
				await operator.canRegister("new@test.invalid", "", false, true),
			).toBe(false);
			expect(
				await operator.canRegister("new@test.invalid", "", true, true),
			).toBe(true);
			await operator.saveSettings(admin, defaultOperatorSettings);
			expect(
				await operator.canRegister("new@test.invalid", "", false, false),
			).toBe(false);
		});
		it("protects self-removal, requires suspension before deletion and revokes credentials immediately", async () => {
			await expect(operator.suspend(admin, admin.userId, true)).rejects.toThrow(
				"own account",
			);
			await expect(operator.deleteUser(admin, admin.userId)).rejects.toThrow(
				"own account",
			);
			await expect(operator.deleteUser(admin, regular.userId)).rejects.toThrow(
				"Suspend",
			);
			const device = randomUUID(),
				agent = randomUUID();
			await database.pool.query(
				'insert into devices(id,"ownerId",label) values($1,$2,$3)',
				[device, regular.userId, "Private device"],
			);
			await database.pool.query(
				'insert into agents(id,"ownerId","deviceId",label) values($1,$2,$3,$4)',
				[agent, regular.userId, device, "Private agent"],
			);
			await database.pool.query(
				'insert into authorizations(id,"agentId","tokenHash") values($1,$2,$3)',
				[randomUUID(), agent, randomUUID()],
			);
			await operator.suspend(admin, regular.userId, true);
			expect(
				(
					await database.pool.query('select 1 from session where "userId"=$1', [
						regular.userId,
					])
				).rowCount,
			).toBe(0);
			expect(
				(
					await database.pool.query(
						'select "revokedAt" from authorizations where "agentId"=$1',
						[agent],
					)
				).rows[0].revokedAt,
			).toBeTruthy();
			expect(revoked).toHaveBeenCalledWith(regular.userId);
			await operator.saveSettings(admin, {
				...defaultOperatorSettings,
				recoveryWindowDays: 3,
			});
			const deleted = await operator.deleteUser(admin, regular.userId);
			expect(
				new Date(deleted.purgeAfter).getTime() - Date.now(),
			).toBeGreaterThan(2.99 * 86400000);
			await expect(
				operator.suspend(admin, regular.userId, false),
			).rejects.toThrow("account-holder recovery");
			const users = await operator.users(admin);
			expect(Object.keys(users[0]).sort()).toEqual(
				[
					"id",
					"name",
					"email",
					"suspended",
					"operator",
					"deletedAt",
					"purgeAfter",
				].sort(),
			);
			expect(JSON.stringify(users)).not.toContain("Private agent");
			expect(
				(
					await database.pool.query(
						"select action from account_audit where actor=$1",
						[admin.userId],
					)
				).rows.map((x) => x.action),
			).toContain("account-suspended");
		});
		it("collects at most once daily, retries durably without content and clears pending on opt-out", async () => {
			await database.pool.query(
				'insert into activity(id,"ownerId",agent,connection,method,target,outcome,"durationMs","createdAt") values($1,$2,$3,$4,$5,$6,$7,1,now() - (86400000) * interval \'1 millisecond\')',
				[
					randomUUID(),
					regular.userId,
					"Private agent",
					"https://sensitive.invalid/mcp",
					"tools/call",
					"private-tool-name",
					"error",
				],
			);
			let failure = true;
			const payloads: unknown[] = [];
			const deliver = vi.fn(async (_url: string, payload: unknown) => {
				if (failure) throw new Error("never persist me");
				payloads.push(payload);
			});
			await operator.saveSettings(admin, defaultOperatorSettings);
			const service = createTelemetryService(database.pool, {
				destination: "https://collector.invalid/api/telemetry",
				deliver,
			});
			await Promise.all([service.tick(), service.tick(), service.tick()]);
			expect(deliver).toHaveBeenCalledTimes(1);
			expect(
				(await database.pool.query("select * from telemetry_daily")).rowCount,
			).toBe(1);
			const row = (await database.pool.query("select * from telemetry_outbox"))
				.rows[0];
			expect(row.attempts).toBe(1);
			expect(JSON.stringify(row)).not.toContain("never persist me");
			failure = false;
			await database.pool.query(
				'update telemetry_outbox set "availableAt"=now()',
			);
			await Promise.all([service.tick(), service.tick()]);
			expect(payloads).toHaveLength(1);
			expect(telemetryPayload.parse(payloads[0])).toEqual({
				schemaVersion: 1,
				period: "day",
				counts: {
					users: "1-9",
					agents: "1-9",
					connections: "0",
					operations: "1-9",
					errors: "1-9",
				},
			});
			expect(
				(await database.pool.query("select * from telemetry_outbox")).rowCount,
			).toBe(0);
			await database.pool.query(
				"insert into telemetry_outbox(day,payload) values(current_date-1,$1)",
				[payloads[0]],
			);
			await operator.saveSettings(admin, {
				...defaultOperatorSettings,
				telemetryEnabled: false,
			});
			await service.tick();
			expect(deliver).toHaveBeenCalledTimes(2);
			expect(
				(await database.pool.query("select * from telemetry_outbox")).rowCount,
			).toBe(0);
			await operator.saveSettings(admin, defaultOperatorSettings);
			await service.tick();
			expect(deliver).toHaveBeenCalledTimes(2);
		});
		it("does not queue or send without an explicitly configured destination", async () => {
			await database.pool.query("delete from telemetry_daily");
			const deliver = vi.fn();
			await createTelemetryService(database.pool, { deliver }).tick();
			expect(deliver).not.toHaveBeenCalled();
			expect(
				(await database.pool.query("select * from telemetry_daily")).rowCount,
			).toBe(0);
		});
		it("rejects DNS rebinding at connection time after a public preflight", async () => {
			await operator.saveSettings(admin, {
				...defaultOperatorSettings,
				allowPrivateNetwork: false,
			});
			const policy = createInstanceDestinationPolicy(database.pool);
			await expect(
				policy.fetch("https://rebind.fixture.invalid"),
			).rejects.toThrow("fetch failed");
			expect(rebinding.preflight).toBe(1);
			expect(rebinding.connected).toBe(1);
			// Plain HTTP admitted for a private preflight answer is refused when the
			// connection-time answer turns public.
			await operator.saveSettings(admin, defaultOperatorSettings);
			await expect(
				policy.fetch("http://rebind-public.fixture.invalid"),
			).rejects.toThrow("fetch failed");
			expect(rebinding.connected).toBe(2);
		});
		it("enforces network settings live for saved destinations and actual connections", async () => {
			const server = createServer((_req, res) => res.end("local fixture"));
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("No fixture port");
			const url = new URL(`http://127.0.0.1:${address.port}`),
				policy = createInstanceDestinationPolicy(database.pool);
			try {
				await operator.saveSettings(admin, defaultOperatorSettings);
				expect(await (await policy.fetch(url)).text()).toBe("local fixture");
				await operator.saveSettings(admin, {
					...defaultOperatorSettings,
					allowPrivateNetwork: false,
				});
				await expect(policy.validateDestination(url)).rejects.toThrow(
					"not permitted",
				);
				await expect(policy.fetch(url)).rejects.toThrow("not permitted");
				await expect(
					policy.validateDestination(new URL("http://169.254.169.254")),
				).rejects.toThrow();
			} finally {
				await new Promise<void>((r, j) =>
					server.close((e) => (e ? j(e) : r())),
				);
			}
		});
	},
);
