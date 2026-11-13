import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccountService } from "../apps/web/src/server/accounts";
import { accountSessionIssuance } from "../apps/web/src/server/fences";
import { createAuth } from "../packages/auth/src/index";
import { authSchema } from "../packages/database/src/schema";
import { createAccountTestDatabase } from "./account-database";

/** A sign-in that passed its password check before a completed recovery must not survive it. */
describe("session issuance during account recovery", () => {
	let database: Awaited<ReturnType<typeof createAccountTestDatabase>>;
	let paused: { reached: () => void; release: Promise<void> } | undefined;
	let auth: ReturnType<typeof createAuth>;
	let accounts: ReturnType<typeof createAccountService>;
	beforeAll(async () => {
		database = await createAccountTestDatabase();
		accounts = createAccountService(database.pool);
		auth = createAuth({
			database: database.db,
			schema: authSchema,
			baseURL: "http://localhost:4310",
			secret: "session-issuance-test-secret-".repeat(2),
			canRegister: async () => true,
			// Runs after the password was accepted, just before the session row is written.
			canSignIn: async () => {
				const gate = paused;
				if (!gate) return;
				paused = undefined;
				gate.reached();
				await gate.release;
			},
			sessionIssuance: accountSessionIssuance(database.pool),
		});
	}, 30000);
	afterAll(async () => {
		await database?.close();
	});
	const sessions = async (userId: string) =>
		(
			await database.pool.query('select id from session where "userId"=$1', [
				userId,
			])
		).rowCount;
	it("compares revocations with the sign-in start at database precision", async () => {
		const subject = randomUUID();
		await database.pool.query(
			`insert into account_audit(id,"subjectId",actor,action,"createdAt") values($1,$2,$2,'account-recovered','2026-01-01 00:00:00.000100+00')`,
			[randomUUID(), subject],
		);
		const { revokedSince } = accountSessionIssuance(database.pool);
		// Same millisecond, later microsecond: a millisecond-truncated start would count it.
		expect(
			await revokedSince(
				database.pool,
				subject,
				"2026-01-01 00:00:00.000500+00",
			),
		).toBe(false);
		expect(
			await revokedSince(
				database.pool,
				subject,
				"2026-01-01 00:00:00.000050+00",
			),
		).toBe(true);
	});
	it("disables library routes that change credentials or disclose sessions", async () => {
		for (const [method, path] of [
			["POST", "/change-password"],
			["GET", "/list-sessions"],
			["POST", "/revoke-session"],
			["POST", "/update-user"],
			["POST", "/change-email"],
			["POST", "/delete-user"],
			["POST", "/link-social"],
			["POST", "/unlink-account"],
			["POST", "/request-password-reset"],
			["POST", "/reset-password"],
		]) {
			const response = await auth.handler(
				new Request(`http://localhost:4310/api/auth${path}`, {
					method,
					headers: {
						origin: "http://localhost:4310",
						"content-type": "application/json",
					},
					...(method === "POST" ? { body: "{}" } : {}),
				}),
			);
			expect([path, response.status]).toEqual([path, 404]);
		}
		await expect(
			auth.api.changePassword({
				body: { currentPassword: "x".repeat(12), newPassword: "y".repeat(12) },
				headers: new Headers(),
			}),
		).rejects.toMatchObject({ statusCode: 404 });
	});
	it("refuses a session for a password replaced while the sign-in was in flight", async () => {
		const email = `${randomUUID()}@test.invalid`,
			password = "original-password-1";
		const { user } = await auth.api.signUpEmail({
			body: { email, password, name: "Recovery race" },
		});
		const codes = await accounts.rotateCodes(user.id);
		// A sign-in without a concurrent recovery succeeds.
		await auth.api.signInEmail({ body: { email, password } });
		let reached!: () => void;
		const atHook = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release!: () => void;
		paused = {
			reached,
			release: new Promise<void>((resolve) => {
				release = resolve;
			}),
		};
		const signIn = Promise.allSettled([
			auth.api.signInEmail({ body: { email, password } }),
		]);
		await atHook;
		await accounts.recover(email, codes[0], "recovered-password-1");
		expect(await sessions(user.id)).toBe(0);
		release();
		const [outcome] = await signIn;
		expect(outcome.status).toBe("rejected");
		expect(await sessions(user.id)).toBe(0);
		// The new password still signs in.
		await auth.api.signInEmail({
			body: { email, password: "recovered-password-1" },
		});
		expect(await sessions(user.id)).toBe(1);
	});
});
