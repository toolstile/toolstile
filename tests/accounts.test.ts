import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccountEmail } from "../apps/web/src/server/account-email";
import { createAccountService } from "../apps/web/src/server/accounts";
import type { Actor } from "../packages/api/src/contract";
import { digest, issueToken, secretBox } from "../packages/auth/src/index";
import { accountTestEnv, createAccountTestDatabase } from "./account-database";
import { startFixture } from "./fixture";

describe.skipIf(!process.env.TEST_BASE_URL)("durable account security", () => {
	let runtime: typeof import("../apps/web/src/server/runtime");
	let database: Awaited<ReturnType<typeof createAccountTestDatabase>>;
	let base: string;
	let fixture: Awaited<ReturnType<typeof startFixture>>;
	const users: string[] = [];
	const clients: string[] = [];
	const password = "Local-account-test-password-12345";
	beforeAll(async () => {
		database = await createAccountTestDatabase();
		vi.stubEnv("DATABASE_URL", database.url);
		runtime = await import("../apps/web/src/server/runtime");
		base = accountTestEnv("BETTER_AUTH_URL");
		fixture = await startFixture();
	});
	afterAll(async () => {
		for (const id of users) {
			await runtime.pool.query(
				'update profiles set "purgeAfter"=now(),"deletedAt"=now() where "userId"=$1',
				[id],
			);
			await runtime.pool.query(
				'insert into profiles("userId","purgeAfter","deletedAt") select id,now(),now() from "user" where id=$1 on conflict("userId") do nothing',
				[id],
			);
		}
		await runtime.accounts.purgeExpired();
		for (const clientId of clients)
			await runtime.pool.query(
				'delete from "oauthClient" where "clientId"=$1',
				[clientId],
			);
		await fixture.close();
		await runtime.pool.end();
		await database.close();
		vi.unstubAllEnvs();
	});
	function request(path: string, body: unknown, cookie = "") {
		return new Request(`${base}/api/auth/${path}`, {
			method: "POST",
			headers: { Origin: base, "Content-Type": "application/json", cookie },
			body: JSON.stringify(body),
		});
	}
	async function signup(email: string | null = `${randomUUID()}@test.invalid`) {
		const token = issueToken();
		await runtime.pool.query(
			"insert into invitations(id,email,\"expiresAt\") values($1,$2,now() + (3600000) * interval '1 millisecond')",
			[digest(token), email ?? null],
		);
		const response = await runtime.handleAuth(
			request("sign-up/email", {
				name: "Account fixture",
				email: email ?? undefined,
				password,
				invitationToken: token,
			}),
		);
		expect(response.status).toBe(200);
		const data = await response.json();
		users.push(data.user.id);
		const cookie = response.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");
		const actor = await runtime.actorFromRequest(
			new Request(base, { headers: { cookie } }),
		);
		return {
			id: data.user.id,
			identifier: data.user.email,
			token,
			cookie,
			actor,
		};
	}
	async function seedAgent(actor: Actor) {
		const device = await runtime.services.addDevice(actor, "Account device");
		const agent = await runtime.services.addAgent(actor, {
			deviceId: device.id,
			label: "Account agent",
			expiresInDays: null,
		});
		return { device, agent };
	}
	it("consumes an invitation once and supports an email-free login identifier", async () => {
		const user = await signup(null);
		expect(user.identifier).toMatch(/@users\.invalid$/);
		expect(
			(
				await runtime.pool.query("select 1 from invitations where id=$1", [
					digest(user.token),
				])
			).rowCount,
		).toBe(0);
		expect(
			(
				await runtime.handleAuth(
					request("sign-up/email", {
						name: "Replay",
						password,
						invitationToken: user.token,
					}),
				)
			).status,
		).toBe(403);
	});
	it("accepts invitation links with an HttpOnly cookie and keeps secrets out of the application redirect", async () => {
		const token = issueToken();
		await runtime.pool.query(
			"insert into invitations(id,email,\"expiresAt\") values($1,null,now() + (3600000) * interval '1 millisecond')",
			[digest(token)],
		);
		const accepted = await runtime.handleAuth(
			new Request(`${base}/api/auth/accept-invitation/${token}`),
		);
		expect(accepted.status).toBe(303);
		expect(accepted.headers.get("location")).toBe("/auth/sign-up");
		expect(accepted.headers.get("set-cookie")).toContain("HttpOnly");
		const cookie = accepted.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const options = await (
			await runtime.handleAuth(
				new Request(`${base}/api/auth/account-options`, {
					headers: { cookie },
				}),
			)
		).json();
		expect(options.invitation).toEqual({ email: null });
		const registered = await runtime.handleAuth(
			request(
				"sign-up/email",
				{ name: "Cookie invitation", password, email: "" },
				cookie,
			),
		);
		expect(registered.status).toBe(200);
		const person = await registered.json();
		users.push(person.user.id);
		expect(person.user.email).toMatch(/@users\.invalid$/);
		expect(
			(
				await runtime.handleAuth(
					new Request(`${base}/api/auth/accept-invitation/${token}`),
				)
			).status,
		).toBe(400);
	});
	it("rejects expired, mismatched and unverified social invitations atomically", async () => {
		const token = issueToken(),
			email = `${randomUUID()}@test.invalid`;
		await runtime.pool.query(
			"insert into invitations(id,email,\"expiresAt\") values($1,$2,now() + (3600000) * interval '1 millisecond')",
			[digest(token), email],
		);
		expect(
			await runtime.accounts.consumeInvitation(email, token, false, true),
		).toBe(false);
		expect(
			await runtime.accounts.consumeInvitation(
				"different@test.invalid",
				token,
				true,
				true,
			),
		).toBe(false);
		const result = await Promise.all(
			Array.from({ length: 8 }, () =>
				runtime.accounts.consumeInvitation(email, token, true, true),
			),
		);
		expect(result.filter(Boolean)).toHaveLength(1);
		const expired = issueToken();
		await runtime.pool.query(
			"insert into invitations(id,email,\"expiresAt\") values($1,null,now() - (1000) * interval '1 millisecond')",
			[digest(expired)],
		);
		expect(
			await runtime.accounts.consumeInvitation(email, expired, true, true),
		).toBe(false);
		await runtime.pool.query("delete from invitations where id=$1", [
			digest(expired),
		]);
	});
	it("detects URL-only connections after validation and persists their derived details without activity", async () => {
		const owner = await signup();
		const connection = await runtime.services.addConnection(owner.actor, {
			url: fixture.url,
			transport: "auto",
			authentication: "auto",
			headers: {},
		});
		expect(connection).toMatchObject({
			label: `${new URL(fixture.url).host}/mcp`,
			transport: "http",
			authentication: "headers",
			status: "reachable",
		});
		const {
			rows: [saved],
		} = await runtime.pool.query(
			'select label,transport,authentication,status,"encryptedHeaders" from connections where id=$1',
			[connection.id],
		);
		expect(saved).toMatchObject({
			label: connection.label,
			transport: connection.transport,
			authentication: connection.authentication,
			status: connection.status,
		});
		expect(saved.encryptedHeaders).not.toBe("{}");
		const { rows } = await runtime.pool.query(
			'select id from activity where "ownerId"=$1',
			[owner.actor.userId],
		);
		expect(rows).toEqual([]);
		await expect(
			runtime.services.addConnection(owner.actor, {
				url: "http://169.254.169.254/mcp",
				transport: "auto",
				authentication: "auto",
				headers: {},
			}),
		).rejects.toThrow();
	});
	it("lets future agents inherit grants and composes explicit blocks live", async () => {
		const owner = await signup(),
			other = await signup();
		const connection = await runtime.services.addConnection(owner.actor, {
			label: "Inherited",
			url: fixture.url,
			transport: "http",
			authentication: "headers",
			headers: {},
		});
		const rules = {
			full: true,
			allow: { tools: [], resources: [], prompts: [] },
			block: { tools: [], resources: [], prompts: [] },
		};
		await runtime.services.saveAllAgentGrant(owner.actor, {
			connectionId: connection.id,
			rules,
		});
		const { agent } = await seedAgent(owner.actor);
		expect(
			(
				await runtime.services.agentCatalog(owner.actor, {
					agentId: agent.id,
					connectionId: connection.id,
				})
			).tools.map((tool) => tool.name),
		).toEqual(["read_docs", "write_note", "delete_note"]);
		const snapshot = await runtime.services.snapshot(owner.actor);
		expect(snapshot.allAgentGrants).toEqual([
			{ connectionId: connection.id, rules },
		]);
		expect(snapshot.grants).toEqual([]);
		await runtime.services.saveGrant(owner.actor, {
			agentId: agent.id,
			connectionId: connection.id,
			rules: {
				...rules,
				full: false,
				block: { tools: ["delete_note"], resources: [], prompts: [] },
			},
		});
		await expect(
			runtime.services.testTool(owner.actor, {
				agentId: agent.id,
				connectionId: connection.id,
				name: "delete_note",
				arguments: {},
			}),
		).rejects.toThrow("blocks it for this agent");
		expect(
			(
				await runtime.services.agentCatalog(owner.actor, {
					agentId: agent.id,
					connectionId: connection.id,
				})
			).tools.map((tool) => tool.name),
		).toEqual(["read_docs", "write_note"]);
		await expect(
			runtime.services.saveAllAgentGrant(other.actor, {
				connectionId: connection.id,
				rules,
			}),
		).rejects.toThrow();
		await runtime.services.removeAllAgentGrant(owner.actor, connection.id);
		expect(
			(await runtime.services.snapshot(owner.actor)).allAgentGrants,
		).toEqual([]);
	});
	it("stores only recovery-code digests, requires fresh sessions, and rotates prior codes", async () => {
		const owner = await signup();
		const first = await runtime.services.rotateRecoveryCodes(owner.actor);
		expect(first.codes).toHaveLength(10);
		const stored = await runtime.pool.query(
			'select hash from recovery_codes where "userId"=$1',
			[owner.id],
		);
		expect(stored.rows.map((r) => r.hash)).toEqual(first.codes.map(digest));
		const next = await runtime.services.rotateRecoveryCodes(owner.actor);
		await expect(
			runtime.accounts.recover(owner.identifier, first.codes[0], password),
		).rejects.toThrow();
		expect(next.codes[0]).not.toBe(first.codes[0]);
		await runtime.pool.query(
			"update session set \"createdAt\"=now() - (660000) * interval '1 millisecond' where id=$1",
			[owner.actor.sessionId],
		);
		await expect(
			runtime.services.rotateRecoveryCodes(owner.actor),
		).rejects.toThrow("Sign in again");
	});
	it("consumes a recovery code once under concurrent requests and revokes sessions and agents", async () => {
		const owner = await signup();
		const { agent } = await seedAgent(owner.actor);
		const { codes } = await runtime.services.rotateRecoveryCodes(owner.actor);
		const results = await Promise.allSettled(
			Array.from({ length: 4 }, () =>
				runtime.accounts.recover(owner.identifier, codes[0], password),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			(
				await runtime.pool.query('select 1 from session where "userId"=$1', [
					owner.id,
				])
			).rowCount,
		).toBe(0);
		expect(
			(
				await runtime.pool.query(
					'select "revokedAt" from authorizations where "agentId"=$1',
					[agent.id],
				)
			).rows[0].revokedAt,
		).toBeTruthy();
		await expect(
			runtime.actorFromRequest(
				new Request(base, { headers: { cookie: owner.cookie } }),
			),
		).rejects.toThrow();
	});
	it("does not issue agents or recovery codes from sessions revoked while account requests wait for a lock", async () => {
		const owner = await signup();
		const device = await runtime.services.addDevice(
			owner.actor,
			"Concurrent fixture",
		);
		const tx = await runtime.pool.connect();
		try {
			await tx.query("BEGIN");
			await tx.query('select id from "user" where id=$1 FOR UPDATE', [
				owner.id,
			]);
			const agent = runtime.services
				.addAgent(owner.actor, {
					deviceId: device.id,
					label: "Racing agent",
					expiresInDays: null,
				})
				.then(
					() => "issued",
					() => "denied",
				);
			const codes = runtime.services.rotateRecoveryCodes(owner.actor).then(
				() => "issued",
				() => "denied",
			);
			await tx.query('delete from session where "userId"=$1', [owner.id]);
			await tx.query("COMMIT");
			tx.release();
			expect(await agent).toBe("denied");
			expect(await codes).toBe("denied");
			expect(
				(
					await runtime.pool.query('select 1 from agents where "ownerId"=$1', [
						owner.id,
					])
				).rowCount,
			).toBe(0);
			expect(
				(
					await runtime.pool.query(
						'select 1 from recovery_codes where "userId"=$1',
						[owner.id],
					)
				).rowCount,
			).toBe(0);
		} finally {
			tx.release();
		}
	});
	it("revokes persisted OAuth access and refresh tokens during recovery", async () => {
		const owner = await signup();
		const { agent } = await seedAgent(owner.actor);
		const clientId = randomUUID(),
			refreshId = randomUUID();
		clients.push(clientId);
		await runtime.pool.query(
			'insert into "oauthClient"(id,"clientId","redirectUris","userId") values($1,$1,$2,$3)',
			[clientId, [`${base}/callback`], owner.id],
		);
		await runtime.pool.query(
			'insert into "oauthRefreshToken"(id,token,"clientId","userId","referenceId","expiresAt","createdAt",scopes) values($1,$2,$3,$4,$5,now() + (3600000) * interval \'1 millisecond\',now(),$6)',
			[refreshId, randomUUID(), clientId, owner.id, agent.id, ["mcp:access"]],
		);
		const accessId = randomUUID();
		await runtime.pool.query(
			'insert into "oauthAccessToken"(id,token,"clientId","userId","refreshId","expiresAt","createdAt",scopes) values($1,$2,$3,$4,$5,now() + (3600000) * interval \'1 millisecond\',now(),$6)',
			[accessId, randomUUID(), clientId, owner.id, refreshId, ["mcp:access"]],
		);
		const { codes } = await runtime.services.rotateRecoveryCodes(owner.actor);
		await runtime.accounts.recover(owner.identifier, codes[0], password);
		for (const [table, id] of [
			["oauthAccessToken", accessId],
			["oauthRefreshToken", refreshId],
		])
			expect(
				(
					await runtime.pool.query(
						`select revoked from "${table}" where id=$1`,
						[id],
					)
				).rows[0].revoked,
			).toBeTruthy();
	});
	it("immediately stops deleted accounts and restores without reviving agent credentials", async () => {
		const owner = await signup();
		const { agent } = await seedAgent(owner.actor);
		const { codes } = await runtime.services.rotateRecoveryCodes(owner.actor);
		const result = await runtime.services.deleteAccount(owner.actor);
		expect(new Date(result.purgeAfter).getTime() - Date.now()).toBeGreaterThan(
			6.9 * 86400000,
		);
		await expect(runtime.services.snapshot(owner.actor)).rejects.toThrow();
		expect(
			(
				await runtime.handleAuth(
					request("sign-in/email", { email: owner.identifier, password }),
				)
			).status,
		).not.toBe(200);
		await runtime.accounts.recover(owner.identifier, codes[0], password);
		expect(
			(await runtime.services.snapshot(owner.actor)).agents.some(
				(a) => a.id === agent.id,
			),
		).toBe(false);
		expect(
			(
				await runtime.pool.query(
					'select "revokedAt" from authorizations where "agentId"=$1',
					[agent.id],
				)
			).rows[0].revokedAt,
		).toBeTruthy();
		expect(
			(
				await runtime.handleAuth(
					request("sign-in/email", { email: owner.identifier, password }),
				)
			).status,
		).toBe(200);
	});
	it("requires suspension for operator deletion and does not bypass suspension during recovery", async () => {
		const owner = await signup();
		const { codes } = await runtime.services.rotateRecoveryCodes(owner.actor);
		await expect(
			runtime.accounts.deleteAccount(owner.id, "operator-fixture"),
		).rejects.toThrow("Suspend");
		await runtime.accounts.suspend(owner.id, "operator-fixture", true);
		await expect(
			runtime.accounts.recover(owner.identifier, codes[0], password),
		).rejects.toThrow();
		await runtime.accounts.deleteAccount(owner.id, "operator-fixture");
		await runtime.accounts.suspend(owner.id, "operator-fixture", false);
		await expect(runtime.services.snapshot(owner.actor)).rejects.toThrow();
	});
	it("audits emergency resets, removes old sign-in methods, and returns a one-use expiring code", async () => {
		const owner = await signup();
		const { agent } = await seedAgent(owner.actor);
		await expect(
			runtime.accounts.emergencyReset(owner.id, "operator", "short"),
		).rejects.toThrow("meaningful reason");
		const code = await runtime.accounts.emergencyReset(
			owner.id,
			"server-operator",
			"Verified identity in person",
		);
		expect(
			(
				await runtime.pool.query('select 1 from account where "userId"=$1', [
					owner.id,
				])
			).rowCount,
		).toBe(0);
		expect(
			(
				await runtime.pool.query(
					'select "revokedAt" from authorizations where "agentId"=$1',
					[agent.id],
				)
			).rows[0].revokedAt,
		).toBeTruthy();
		const {
			rows: [audit],
		} = await runtime.pool.query(
			"select * from account_audit where \"subjectId\"=$1 and action='emergency-reset'",
			[owner.id],
		);
		expect(audit.reason).toBe("Verified identity in person");
		expect(JSON.stringify(audit)).not.toContain(code);
		const {
			rows: [stored],
		} = await runtime.pool.query(
			'select * from recovery_codes where "userId"=$1',
			[owner.id],
		);
		expect(stored.expiresAt).toBeTruthy();
		await runtime.accounts.recover(owner.identifier, code, password);
		await expect(
			runtime.accounts.recover(owner.identifier, code, password),
		).rejects.toThrow();
	});
	it("purges expired data and prevents recovery after the deadline", async () => {
		const owner = await signup();
		await seedAgent(owner.actor);
		const { codes } = await runtime.services.rotateRecoveryCodes(owner.actor);
		await runtime.services.addConnection(owner.actor, {
			label: "Cleanup",
			url: "http://127.0.0.1:1/mcp",
			transport: "http",
			authentication: "headers",
			headers: { Authorization: "secret" },
		});
		await runtime.accounts.deleteAccount(owner.id, owner.id);
		await runtime.pool.query(
			'update profiles set "purgeAfter"=now() - (1000) * interval \'1 millisecond\' where "userId"=$1',
			[owner.id],
		);
		await expect(
			runtime.accounts.recover(owner.identifier, codes[0], password),
		).rejects.toThrow();
		await Promise.all([
			runtime.accounts.purgeExpired(),
			runtime.accounts.purgeExpired(),
		]);
		expect(
			(await runtime.pool.query('select 1 from "user" where id=$1', [owner.id]))
				.rowCount,
		).toBe(0);
		expect(
			(
				await runtime.pool.query(
					"select 1 from account_audit where \"subjectId\"=$1 and action='account-purged'",
					[owner.id],
				)
			).rowCount,
		).toBe(1);
	});
	it("queues only verified-email recovery, encrypts delivery, and retries durably", async () => {
		const owner = await signup();
		const box = secretBox(accountTestEnv("ENCRYPTION_KEY"));
		const sent: {
			to: string;
			subject: string;
			text: string;
		}[] = [];
		let fail = true;
		const mail = createAccountEmail(runtime.pool, box, async (message) => {
			if (fail) throw new Error("fixture outage");
			sent.push(message);
		});
		const service = createAccountService(runtime.pool, {
			enqueueRecovery: async (tx, userId, email, code) =>
				mail.enqueue(
					tx,
					userId,
					digest(code),
					{ to: email, subject: "Recovery", text: code },
					new Date(Date.now() + 900000),
				),
		});
		await service.requestEmailRecovery(owner.identifier);
		expect(
			(
				await runtime.pool.query(
					'select 1 from account_email_outbox where "userId"=$1',
					[owner.id],
				)
			).rowCount,
		).toBe(0);
		await runtime.pool.query(
			'update "user" set "emailVerified"=true where id=$1',
			[owner.id],
		);
		await Promise.all([
			service.requestEmailRecovery(owner.identifier),
			service.requestEmailRecovery(owner.identifier),
		]);
		let { rows } = await runtime.pool.query(
			'select * from account_email_outbox where "userId"=$1',
			[owner.id],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].encryptedMessage).not.toContain(owner.identifier);
		await mail.flush();
		({ rows } = await runtime.pool.query(
			'select * from account_email_outbox where "userId"=$1',
			[owner.id],
		));
		expect(rows[0].attempts).toBe(1);
		expect(sent).toHaveLength(0);
		await runtime.pool.query(
			'update account_email_outbox set "availableAt"=now() where "userId"=$1',
			[owner.id],
		);
		fail = false;
		await Promise.all([mail.flush(), mail.flush()]);
		expect(sent).toHaveLength(1);
		await service.recover(owner.identifier, sent[0].text, password);
		await expect(
			service.recover(owner.identifier, sent[0].text, password),
		).rejects.toThrow();
	});
	it("enforces recovery origins and does not reveal whether email recovery exists", {
		timeout: 20_000,
	}, async () => {
		const req = request("recover-account", {
			identifier: "unknown",
			code: "wrong",
			password,
		});
		expect((await runtime.handleAuth(req)).status).toBe(400);
		const foreign = new Request(`${base}/api/auth/recover-account`, {
			method: "POST",
			headers: {
				Origin: "https://other.invalid",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ identifier: "unknown", code: "wrong", password }),
		});
		expect((await runtime.handleAuth(foreign)).status).toBe(403);
		expect(
			await (
				await runtime.handleAuth(
					request("request-account-recovery", { identifier: "unknown" }),
				)
			).json(),
		).toEqual({ ok: true });
		// Body limits answer before the confidential response or code validation.
		const paths = ["request-account-recovery", "recover-account"];
		const oversized = { identifier: "x".repeat(20 * 1024) };
		for (const path of paths)
			expect((await runtime.handleAuth(request(path, oversized))).status).toBe(
				413,
			);
		// Stalled bodies end at the auth read deadline with 408, not the generic reply.
		const stalled = await Promise.all(
			paths.map((path) =>
				runtime.handleAuth(
					new Request(`${base}/api/auth/${path}`, {
						method: "POST",
						headers: { Origin: base, "Content-Type": "application/json" },
						body: new ReadableStream<Uint8Array>(),
						duplex: "half",
					} as RequestInit),
				),
			),
		);
		expect(stalled.map((response) => response.status)).toEqual([408, 408]);
	});
});
