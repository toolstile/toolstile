import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	purgeExpiredOAuth,
	purgeExpiredSessions,
} from "../packages/database/src/index";
import { createAccountTestDatabase } from "./account-database";

describe.skipIf(!process.env.TEST_BASE_URL)("expired session purge", () => {
	let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
	const userId = randomUUID();
	beforeAll(async () => {
		storage = await createAccountTestDatabase();
		await storage.pool.query(
			'insert into "user"(id,name,email) values($1,$2,$3)',
			[userId, "Fixture", `${userId}@test.invalid`],
		);
	});
	afterAll(async () => {
		await storage?.close();
	});
	async function session(expiresAt: number) {
		const id = randomUUID();
		await storage.pool.query(
			`insert into session(id,token,"expiresAt","userId","ipAddress","userAgent") values($1,$2,now() + $3::double precision * interval '1 millisecond',$4,'192.0.2.1','fixture')`,
			[id, randomUUID(), expiresAt, userId],
		);
		return id;
	}
	async function remaining(ids: string[]) {
		const { rows } = await storage.pool.query<{
			id: string;
		}>(
			"select id from session where id IN (SELECT value FROM jsonb_array_elements_text($1))",
			[ids],
		);
		return new Set(rows.map((row) => row.id));
	}
	it("deletes only sessions expired beyond the grace period, in bounded batches", async () => {
		const active = await session(86400000);
		const grace = await session(-1800000);
		const stale = await Promise.all(
			Array.from({ length: 5 }, () => session(-7200000)),
		);
		// Two batches of two cap this scan at four deletions; the next scan continues.
		expect(
			await purgeExpiredSessions(storage.pool, { batch: 2, batches: 2 }),
		).toBe(4);
		expect((await remaining(stale)).size).toBe(1);
		expect(
			await purgeExpiredSessions(storage.pool, { batch: 2, batches: 2 }),
		).toBe(1);
		const left = await remaining([active, grace, ...stale]);
		expect([...left].sort()).toEqual([active, grace].sort());
		expect(await purgeExpiredSessions(storage.pool)).toBe(0);
	});
	it("cascades session-bound OAuth selections", async () => {
		const stale = await session(-7200000);
		await storage.pool.query(
			`insert into oauth_flow_selection(id,"sessionId","userId","referenceId","expiresAt") values($1,$2,$3,'ref',now() + (3600000) * interval '1 millisecond')`,
			[randomUUID(), stale, userId],
		);
		expect(await purgeExpiredSessions(storage.pool)).toBe(1);
		expect(
			(
				await storage.pool.query(
					'select 1 from oauth_flow_selection where "sessionId"=$1',
					[stale],
				)
			).rowCount,
		).toBe(0);
	});
	it("purges abandoned CLI sign-in codes and approvals never redeemed", async () => {
		const q = (text: string, values: unknown[] = []) =>
			storage.pool.query(text, values);
		async function code(expiresAt: number) {
			const id = randomUUID();
			await q(
				`insert into device_code(id,"deviceCode","userCode","userId","expiresAt",status) values($1,$2,$3,$4,now() + $5::double precision * interval '1 millisecond','pending')`,
				[id, randomUUID(), randomUUID(), userId, expiresAt],
			);
			return id;
		}
		const codes = [
			await code(-7200000),
			await code(-1800000),
			await code(600000),
		];
		const deviceId = randomUUID();
		await q('insert into devices(id,"ownerId",label) values($1,$2,$3)', [
			deviceId,
			userId,
			"CLI box",
		]);
		async function link(age: number, sessionId: string | null = null) {
			const deviceCode = randomUUID();
			await q(
				`insert into cli_device_links("deviceCode","userId","deviceId","sessionId","createdAt") values($1,$2,$3,$4,now() - $5::double precision * interval '1 millisecond')`,
				[deviceCode, userId, deviceId, sessionId, age],
			);
			return deviceCode;
		}
		const links = [
			await link(7200000),
			await link(600000),
			await link(7200000, await session(86400000)),
		];
		// Only sessions count toward the result.
		expect(await purgeExpiredSessions(storage.pool)).toBe(0);
		const left = async (table: string, column: string, values: string[]) =>
			(
				await q(
					`select "${column}" as id from ${table} where "${column}" IN (SELECT value FROM jsonb_array_elements_text($1))`,
					[values],
				)
			).rows
				.map((row) => row.id)
				.sort();
		expect(await left("device_code", "id", codes)).toEqual(
			codes.slice(1).sort(),
		);
		expect(await left("cli_device_links", "deviceCode", links)).toEqual(
			links.slice(1).sort(),
		);
	});
	it("purges unusable OAuth tokens, selections and abandoned registrations", async () => {
		const q = (text: string, values: unknown[] = []) =>
			storage.pool.query(text, values);
		async function client(age: number, discovery: string | null = null) {
			const clientId = randomUUID();
			await q(
				`insert into "oauthClient"(id,"clientId","redirectUris","clientDiscoveryId","createdAt") values($1,$2,'["http://127.0.0.1/cb"]',$3,now() - $4::double precision * interval '1 millisecond')`,
				[randomUUID(), clientId, discovery, age],
			);
			return clientId;
		}
		async function refresh(clientId: string, expires: number) {
			const id = randomUUID();
			await q(
				`insert into "oauthRefreshToken"(id,token,"clientId","userId","expiresAt","createdAt",scopes) values($1,$2,$3,$4,now() + $5::double precision * interval '1 millisecond',now(),'["mcp:access"]')`,
				[id, randomUUID(), clientId, userId, expires],
			);
			return id;
		}
		async function access(
			clientId: string,
			expires: number,
			refreshId: string | null = null,
		) {
			const id = randomUUID();
			await q(
				`insert into "oauthAccessToken"(id,token,"clientId","userId","refreshId","expiresAt","createdAt",scopes) values($1,$2,$3,$4,$5,now() + $6::double precision * interval '1 millisecond',now(),'["mcp:access"]')`,
				[id, randomUUID(), clientId, userId, refreshId, expires],
			);
			return id;
		}
		const live = await client(3456000000);
		const abandoned = await client(3456000000);
		const recent = await client(86400000);
		const discovered = await client(3456000000, "cimd");
		const consented = await client(3456000000);
		await q(
			`insert into "oauthConsent"(id,"clientId","userId",scopes,"createdAt","updatedAt") values($1,$2,$3,'["mcp:access"]',now(),now())`,
			[randomUUID(), consented, userId],
		);
		const activeRefresh = await refresh(live, 1728000000);
		const staleRefresh = await refresh(live, -172800000);
		const pinnedRefresh = await refresh(live, -172800000);
		const graceRefresh = await refresh(live, -3600000);
		const activeAccess = await access(live, 3600000, activeRefresh);
		const staleAccess = await access(live, -7200000, staleRefresh);
		// A live access token keeps its expired refresh row until it expires too.
		const pinnedAccess = await access(live, 3600000, pinnedRefresh);
		const graceAccess = await access(live, -600000);
		const selections = [];
		for (const expires of [-7200000, -600000, 3600000]) {
			const id = randomUUID();
			await q(
				`insert into oauth_flow_selection(id,"sessionId","userId","referenceId","expiresAt") values($1,$2,$3,'ref',now() + $4::double precision * interval '1 millisecond')`,
				[id, await session(86400000), userId, expires],
			);
			selections.push(id);
		}
		expect(await purgeExpiredOAuth(storage.pool)).toBe(4);
		const ids = async (table: string, column: string, values: string[]) =>
			new Set(
				(
					await q(
						`select "${column}" as id from "${table}" where "${column}" IN (SELECT value FROM jsonb_array_elements_text($1))`,
						[values],
					)
				).rows.map((row) => row.id),
			);
		expect(
			await ids("oauthAccessToken", "id", [
				activeAccess,
				staleAccess,
				pinnedAccess,
				graceAccess,
			]),
		).toEqual(new Set([activeAccess, pinnedAccess, graceAccess]));
		expect(
			await ids("oauthRefreshToken", "id", [
				activeRefresh,
				staleRefresh,
				pinnedRefresh,
				graceRefresh,
			]),
		).toEqual(new Set([activeRefresh, pinnedRefresh, graceRefresh]));
		expect(await ids("oauth_flow_selection", "id", selections)).toEqual(
			new Set(selections.slice(1)),
		);
		expect(
			await ids("oauthClient", "clientId", [
				live,
				abandoned,
				recent,
				discovered,
				consented,
			]),
		).toEqual(new Set([live, recent, discovered, consented]));
	});
});
