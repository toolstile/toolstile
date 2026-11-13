import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccountService } from "../apps/web/src/server/accounts";
import { createAuth, digest, issueToken } from "../packages/auth/src/index";
import { authSchema } from "../packages/database/src/index";
import { accountTestEnv, createAccountTestDatabase } from "./account-database";

describe.skipIf(!process.env.TEST_BASE_URL)(
	"invitation-aware social callbacks",
	() => {
		let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
		let accounts: ReturnType<typeof createAccountService>;
		let auth: ReturnType<typeof createAuth>;
		let base: string;
		let email = "",
			subject = "",
			verified = true,
			nonce: string | null = null;
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const fixtureUsers: string[] = [];
		beforeAll(async () => {
			base = accountTestEnv("BETTER_AUTH_URL");
			storage = await createAccountTestDatabase();
			accounts = createAccountService(storage.pool);
			auth = createAuth({
				database: storage.db,
				schema: authSchema,
				baseURL: base,
				secret: accountTestEnv("BETTER_AUTH_SECRET"),
				cookiePrefix: "social-fixture",
				socialProviders: {
					github: {
						clientId: "github-fixture",
						clientSecret: "github-fixture-secret",
					},
					google: {
						clientId: "google-fixture",
						clientSecret: "google-fixture-secret",
					},
				},
				canRegister: (email, identity) =>
					accounts.consumeInvitation(
						email,
						identity?.invitationToken ?? "",
						!!identity?.verified,
						true,
					),
			});
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url === "https://github.com/login/oauth/access_token")
					return Response.json({
						access_token: "fixture-social-access",
						token_type: "bearer",
						scope: "read:user,user:email",
					});
				if (url === "https://api.github.com/user")
					return Response.json({
						id: subject,
						name: "Fixture",
						login: "fixture",
						email,
						avatar_url: null,
					});
				if (url === "https://api.github.com/user/emails")
					return Response.json([{ email, primary: true, verified }]);
				if (url === "https://oauth2.googleapis.com/token") {
					const header = Buffer.from(
						JSON.stringify({ alg: "RS256", kid: "fixture-key", typ: "JWT" }),
					).toString("base64url");
					const claims = Buffer.from(
						JSON.stringify({
							iss: "https://accounts.google.com",
							aud: "google-fixture",
							sub: subject,
							email,
							email_verified: verified,
							name: "Fixture",
							iat: Math.floor(Date.now() / 1000),
							exp: Math.floor(Date.now() / 1000) + 3600,
							...(nonce ? { nonce } : {}),
						}),
					).toString("base64url");
					const unsigned = `${header}.${claims}`;
					const signature = createSign("RSA-SHA256")
						.update(unsigned)
						.sign(privateKey)
						.toString("base64url");
					return Response.json({
						access_token: "fixture-google-access",
						token_type: "bearer",
						id_token: `${unsigned}.${signature}`,
						expires_in: 3600,
					});
				}
				if (url === "https://www.googleapis.com/oauth2/v3/certs")
					return Response.json({
						keys: [
							{
								...publicKey.export({ format: "jwk" }),
								kid: "fixture-key",
								alg: "RS256",
								use: "sig",
							},
						],
					});
				throw new Error(`Unexpected social fixture fetch: ${url}`);
			});
		});
		afterAll(async () => {
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			for (const userId of fixtureUsers)
				await storage.pool.query(
					'insert into profiles("userId","deletedAt","purgeAfter") values($1,now(),now()) on conflict("userId") do update set "deletedAt"=now(),"purgeAfter"=now()',
					[userId],
				);
			await accounts.purgeExpired();
			await storage.close();
		});
		async function invite(invitedEmail: string | null) {
			const token = issueToken();
			await storage.pool.query(
				"insert into invitations(id,email,\"expiresAt\") values($1,$2,now() + (3600000) * interval '1 millisecond')",
				[digest(token), invitedEmail],
			);
			return token;
		}
		async function social(provider: "github" | "google", token?: string) {
			const response = await auth.handler(
				new Request(`${base}/api/auth/sign-in/social`, {
					method: "POST",
					headers: { Origin: base, "Content-Type": "application/json" },
					body: JSON.stringify({
						provider,
						callbackURL: `${base}/`,
						additionalData: token ? { invitationToken: token } : undefined,
					}),
				}),
			);
			expect(response.status).toBe(200);
			const { url } = await response.json();
			const authorization = new URL(url);
			nonce = authorization.searchParams.get("nonce");
			const cookie = response.headers
				.getSetCookie()
				.map((c) => c.split(";")[0])
				.join("; ");
			return auth.handler(
				new Request(
					`${base}/api/auth/callback/${provider}?state=${authorization.searchParams.get("state")}&code=fixture-code`,
					{ headers: { cookie } },
				),
			);
		}
		for (const provider of ["github", "google"] as const) {
			it(`${provider} rejects invitation-free and mismatched registration`, async () => {
				email = `${randomUUID()}@test.invalid`;
				subject = randomUUID();
				verified = true;
				expect((await social(provider)).headers.get("location")).toContain(
					"error",
				);
				const token = await invite("someone-else@test.invalid");
				expect(
					(await social(provider, token)).headers.get("location"),
				).toContain("error");
				expect(
					(
						await storage.pool.query('select 1 from "user" where email=$1', [
							email,
						])
					).rowCount,
				).toBe(0);
				await storage.pool.query("delete from invitations where id=$1", [
					digest(token),
				]);
			});
			it(`${provider} consumes a verified invitation and signs the same user back in without another invite`, async () => {
				email = `${randomUUID()}@test.invalid`;
				subject = randomUUID();
				verified = true;
				const token = await invite(email);
				const response = await social(provider, token);
				expect(response.headers.get("location")).toBe(`${base}/`);
				const {
					rows: [person],
				} = await storage.pool.query('select id from "user" where email=$1', [
					email,
				]);
				expect(person).toBeTruthy();
				fixtureUsers.push(person.id);
				expect(
					(
						await storage.pool.query("select 1 from invitations where id=$1", [
							digest(token),
						])
					).rowCount,
				).toBe(0);
				const stored = async () =>
					(
						await storage.pool.query<{
							accessToken: string;
							idToken: string | null;
						}>(
							'select "accessToken","idToken" from account where "userId"=$1',
							[person.id],
						)
					).rows[0];
				const linked = await stored();
				expect(linked?.accessToken).not.toContain(
					provider === "github"
						? "fixture-social-access"
						: "fixture-google-access",
				);
				// Google returns an ID token; it is verified at sign-in but never kept.
				expect(linked?.idToken).toBeNull();
				expect((await social(provider)).headers.get("location")).toBe(
					`${base}/`,
				);
				// Repeat sign-in updates the account row and must not store it either.
				expect((await stored())?.idToken).toBeNull();
			});
			it(`${provider} refuses unverified email and accepts a verified identity with an email-free invitation`, async () => {
				email = `${randomUUID()}@test.invalid`;
				subject = randomUUID();
				verified = false;
				const token = await invite(null);
				expect(
					(await social(provider, token)).headers.get("location"),
				).toContain("error");
				expect(
					(
						await storage.pool.query("select 1 from invitations where id=$1", [
							digest(token),
						])
					).rowCount,
				).toBe(1);
				verified = true;
				expect((await social(provider, token)).headers.get("location")).toBe(
					`${base}/`,
				);
				const {
					rows: [person],
				} = await storage.pool.query('select id from "user" where email=$1', [
					email,
				]);
				fixtureUsers.push(person.id);
			});
		}
		it("does not implicitly link a different provider merely because its verified email matches", async () => {
			const {
				rows: [person],
			} = await storage.pool.query('select email from "user" where id=$1', [
				fixtureUsers[0],
			]);
			email = person.email;
			subject = randomUUID();
			verified = true;
			expect((await social("google")).headers.get("location")).toContain(
				"error",
			);
			expect(
				(
					await storage.pool.query(
						'select 1 from account where "userId"=$1 and "providerId"=\'google\'',
						[fixtureUsers[0]],
					)
				).rowCount,
			).toBe(0);
		});
	},
);
