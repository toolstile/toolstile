import { createHash, randomUUID } from "node:crypto";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { secretBox } from "../packages/auth/src/index";
import { createUpstreamOAuthService } from "../packages/auth/src/upstream";
import type { openDatabase } from "../packages/database/src/index";
import { DestinationError } from "../packages/gateway/src/index";
import { createAccountTestDatabase } from "./account-database";
import { defined } from "./assertions";
import { oauthFixture } from "./oauth-fixture";

describe.skipIf(!process.env.TEST_BASE_URL)(
	"persisted upstream OAuth authorization",
	() => {
		let pool: ReturnType<typeof openDatabase>["pool"];
		let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
		let service: ReturnType<typeof createUpstreamOAuthService<void>>;
		let box: ReturnType<typeof secretBox>;
		let fixture: ReturnType<typeof oauthFixture>;
		const owner = { userId: randomUUID(), sessionId: randomUUID() },
			connectionId = randomUUID();
		let allowed = true;
		let authorizedUrl = "";
		const registeredClients: Record<
			string,
			{
				clientId: string;
				clientSecret?: string;
				issuer?: string;
			}
		> = {};
		const requests: {
			url: string;
			body: string;
		}[] = [];
		let failureMode:
				| ""
				| "network"
				| "invalid_grant"
				| "discovery"
				| "refused"
				| "policy" = "",
			failedRequests = 0;
		/** Runs while a failing refresh is in flight, before the provider answers. */
		let duringFailedRefresh: (() => Promise<void>) | undefined;
		beforeAll(async () => {
			storage = await createAccountTestDatabase();
			pool = storage.pool;
			box = secretBox(defined(process.env.ENCRYPTION_KEY));
			await pool.query('insert into "user"(id,name,email) values($1,$2,$3)', [
				owner.userId,
				"OAuth fixture",
				`${owner.userId}@test.invalid`,
			]);
			await pool.query(
				'insert into session(id,token,"userId","expiresAt") values($1,$2,$3,$4)',
				[
					owner.sessionId,
					randomUUID(),
					owner.userId,
					new Date(Date.now() + 3600000),
				],
			);
			await pool.query(
				'insert into connections(id,"ownerId",label,url,transport,authentication,"encryptedHeaders") values($1,$2,$3,$4,$5,$6,$7)',
				[
					connectionId,
					owner.userId,
					"OAuth test",
					"https://mcp.example/mcp",
					"http",
					"oauth",
					box.encrypt({}),
				],
			);
		});
		beforeEach(async () => {
			allowed = true;
			authorizedUrl = "https://mcp.example/mcp";
			for (const key of Object.keys(registeredClients))
				delete registeredClients[key];
			requests.length = 0;
			failureMode = "";
			failedRequests = 0;
			duringFailedRefresh = undefined;
			fixture = oauthFixture(
				"http://gateway.localhost/oauth/upstream/callback",
			);
			await pool.query('delete from connection_oauth where "connectionId"=$1', [
				connectionId,
			]);
			await pool.query("update connections set status=$2,url=$3 where id=$1", [
				connectionId,
				"authentication required",
				"https://mcp.example/mcp",
			]);
			service = createUpstreamOAuthService<void>({
				pool,
				box,
				baseURL: "http://gateway.localhost",
				// The catalog marks this origin as needing an operator client.
				registeredClient: async (origin) =>
					registeredClients[origin]
						? { required: true, client: registeredClients[origin] }
						: origin === "https://api.githubcopilot.com"
							? { required: true }
							: undefined,
				fetch: async (input, init) => {
					const url = String(input);
					requests.push({ url, body: String(init?.body ?? "") });
					if (failureMode === "discovery")
						throw new Error("private provider diagnostics: synthetic-secret");
					if (authorizedUrl.startsWith("https://api.githubcopilot.com")) {
						if (url.includes("/.well-known/oauth-protected-resource"))
							return Response.json({
								resource: authorizedUrl,
								authorization_servers: ["https://github.com/login/oauth"],
							});
						if (
							url ===
							"https://github.com/.well-known/oauth-authorization-server/login/oauth"
						)
							return Response.json({
								issuer: "https://github.com/login/oauth",
								authorization_endpoint:
									"https://github.com/login/oauth/authorize",
								token_endpoint: "https://github.com/login/oauth/access_token",
								response_types_supported: ["code"],
								grant_types_supported: ["authorization_code", "refresh_token"],
								code_challenge_methods_supported: ["S256"],
								authorization_response_iss_parameter_supported: true,
							});
						if (url === "https://github.com/login/oauth/access_token")
							return Response.json({
								access_token: "synthetic-github-access",
								refresh_token: "synthetic-github-refresh",
								token_type: "Bearer",
								expires_in: 3600,
							});
					}
					if (String(input).endsWith("/token") && failureMode) {
						failedRequests++;
						await duringFailedRefresh?.();
						if (failureMode === "network")
							throw new TypeError("fixture connection refused");
						// The policy's connection-time address check surfaces inside "fetch failed".
						if (failureMode === "refused")
							throw new TypeError("fetch failed", {
								cause: new DestinationError(
									"Destination address is not permitted by network settings",
									"network",
								),
							});
						return Response.json({ error: "invalid_grant" }, { status: 400 });
					}
					if (
						url === `${fixture.issuer}/.well-known/oauth-authorization-server`
					) {
						const metadata = await (await fixture.request(input, init)).json();
						return Response.json({
							...metadata,
							token_endpoint_auth_methods_supported: [
								"none",
								"client_secret_post",
							],
						});
					}
					return fixture.request(input, init);
				},
				validateDestination: async (url) => {
					if (failureMode === "policy" && url.pathname.endsWith("/token"))
						throw new DestinationError(
							"Destination address is not permitted by network settings",
							"network",
						);
					if (
						![
							"https://mcp.example",
							"https://accounts.example",
							"https://api.githubcopilot.com",
							"https://github.com",
						].includes(url.origin)
					)
						throw new Error("Destination rejected");
				},
				authorize: async (current) => {
					if (!allowed || current.userId !== owner.userId)
						throw new Error("Access revoked");
					return { url: authorizedUrl };
				},
				saveContext: async () => {},
				loadContext: async () => undefined,
			});
		});
		afterAll(async () => {
			await pool?.query("delete from connections where id=$1", [connectionId]);
			await service?.cleanupUnusedGrants();
			await pool?.query('delete from "user" where id=$1', [owner.userId]);
			await storage?.close();
			await pool?.end();
		});
		async function begin() {
			const { url } = await service.begin(owner, connectionId, undefined);
			fixture.setRedirect(url);
			return defined(new URL(url).searchParams.get("state"));
		}
		async function connect() {
			const state = await begin();
			// The callback redirect names the signed-in connection.
			expect(
				await service.finish(owner, state, "fixture-code", fixture.issuer),
			).toEqual({ connectionId, context: undefined });
		}
		it("uses an issuer-bound registered GitHub client without dynamic registration and keeps its secret server-side", async () => {
			authorizedUrl = "https://api.githubcopilot.com/mcp/";
			await pool.query("update connections set url=$2 where id=$1", [
				connectionId,
				authorizedUrl,
			]);
			registeredClients["https://api.githubcopilot.com"] = {
				clientId: "synthetic-github-client",
				clientSecret: "synthetic-github-secret",
				issuer: "https://github.com/login/oauth",
			};
			const { url } = await service.begin(owner, connectionId, undefined);
			const redirect = new URL(url);
			expect(redirect.origin).toBe("https://github.com");
			expect(redirect.searchParams.get("client_id")).toBe(
				"synthetic-github-client",
			);
			expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
			expect(url).not.toContain("synthetic-github-secret");
			await service.finish(
				owner,
				defined(redirect.searchParams.get("state")),
				"synthetic-code",
				"https://github.com/login/oauth",
			);
			const token = defined(
				requests.find(
					(r) => r.url === "https://github.com/login/oauth/access_token",
				),
			);
			expect(new URLSearchParams(token.body).get("client_secret")).toBe(
				"synthetic-github-secret",
			);
			expect(requests.some((r) => r.url.includes("register"))).toBe(false);
			const row = (
				await pool.query(
					'select g."encryptedData" from upstream_oauth_grants g join connection_oauth c on c."grantId"=g.id where c."connectionId"=$1',
					[connectionId],
				)
			).rows[0];
			expect(row.encryptedData).not.toContain("synthetic-github-secret");
		});
		it("reports missing GitHub registration as a safe setup error before allocating a flow", async () => {
			authorizedUrl = "https://api.githubcopilot.com/mcp/";
			await pool.query("update connections set url=$2 where id=$1", [
				connectionId,
				authorizedUrl,
			]);
			await expect(
				service.begin(owner, connectionId, undefined),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
				message: expect.stringContaining(
					"browser sign-in requires a registered OAuth application",
				),
			});
			expect(requests).toEqual([]);
		});
		it("allows explicit user-owned registration to override the operator client", async () => {
			registeredClients["https://mcp.example"] = {
				clientId: "operator-client",
				clientSecret: "operator-secret",
				issuer: fixture.issuer,
			};
			const { url } = await service.begin(owner, connectionId, undefined, {
				clientId: "fixture-client",
				clientSecret: "user-client-secret",
			});
			fixture.setRedirect(url);
			await service.finish(
				owner,
				defined(new URL(url).searchParams.get("state")),
				"fixture-code",
				fixture.issuer,
			);
			const token = defined(
				requests.find((r) => r.url === `${fixture.issuer}/token`),
			);
			expect(new URLSearchParams(token.body).get("client_secret")).toBe(
				"user-client-secret",
			);
			expect(requests.every((r) => !r.body.includes("operator-secret"))).toBe(
				true,
			);
		});
		it("does not apply another origin's registered credentials", async () => {
			registeredClients["https://mcp.example.attacker.test"] = {
				clientId: "wrong-origin-client",
				clientSecret: "wrong-origin-secret",
			};
			await connect();
			expect(requests.some((r) => r.url === `${fixture.issuer}/register`)).toBe(
				true,
			);
			expect(
				requests.every((r) => !r.body.includes("wrong-origin-secret")),
			).toBe(true);
		});
		it("does not transmit a registered secret to a different authorization issuer", async () => {
			registeredClients["https://mcp.example"] = {
				clientId: "operator-client",
				clientSecret: "operator-secret",
				issuer: "https://github.com/login/oauth",
			};
			await connect();
			expect(requests.every((r) => !r.body.includes("operator-secret"))).toBe(
				true,
			);
		});
		it("returns safe setup guidance and erases pending credentials when discovery fails", async () => {
			failureMode = "discovery";
			await expect(
				service.begin(owner, connectionId, undefined),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				message:
					"Could not start MCP sign-in. Check its OAuth support and registered client settings, or try again if the provider is temporarily unavailable.",
			});
			const pending = await pool.query(
				'select "consumedAt", "encryptedData" from upstream_oauth_flows where "connectionId"=$1 order by "expiresAt" desc limit 1',
				[connectionId],
			);
			expect(pending.rows[0].consumedAt).not.toBeNull();
			expect(box.decrypt(pending.rows[0].encryptedData)).toEqual({
				version: 1,
			});
		});
		it("encrypts pending PKCE, binds the callback to its session and consumes state once", async () => {
			const state = await begin();
			const {
				rows: [pending],
			} = await pool.query(
				'select id,"encryptedData" from upstream_oauth_flows where "connectionId"=$1 and "consumedAt" is null',
				[connectionId],
			);
			expect(pending.id).toBe(createHash("sha256").update(state).digest("hex"));
			expect(pending.encryptedData).not.toContain("fixture-client");
			expect(
				box.decrypt<{
					verifier: string;
				}>(pending.encryptedData).verifier,
			).toBeTypeOf("string");
			await expect(
				service.finish(
					{ ...owner, sessionId: randomUUID() },
					state,
					"fixture-code",
					fixture.issuer,
				),
			).rejects.toThrow("invalid or expired");
			await service.finish(owner, state, "fixture-code", fixture.issuer);
			await expect(
				service.finish(owner, state, "fixture-code", fixture.issuer),
			).rejects.toThrow("invalid or expired");
			expect(fixture.tokenRequests()).toBe(1);
			const {
				rows: [grant],
			} = await pool.query(
				'select g."encryptedData" from upstream_oauth_grants g join connection_oauth c on c."grantId"=g.id where c."connectionId"=$1',
				[connectionId],
			);
			expect(grant.encryptedData).not.toContain("fixture-access");
			expect(
				box.decrypt<{
					verifier?: string;
				}>(grant.encryptedData).verifier,
			).toBeUndefined();
			expect(
				await service.runtimeProvider(connectionId, fixture.server).token(),
			).toBe("fixture-access-1");
		});
		it("rejects revoked ownership and expired flows before token redemption", async () => {
			const state = await begin();
			allowed = false;
			await expect(
				service.finish(owner, state, "fixture-code", fixture.issuer),
			).rejects.toThrow("Access revoked");
			expect(fixture.tokenRequests()).toBe(0);
			allowed = true;
			const expired = await begin();
			await pool.query(
				"update upstream_oauth_flows set \"expiresAt\"=now() - (60000) * interval '1 millisecond' where id=$1",
				[createHash("sha256").update(expired).digest("hex")],
			);
			await expect(
				service.finish(owner, expired, "fixture-code", fixture.issuer),
			).rejects.toThrow("invalid or expired");
			expect(fixture.tokenRequests()).toBe(0);
		});
		it("rejects an issuer mix-up and requires explicit approval before replacing authentication", async () => {
			const state = await begin();
			await expect(
				service.finish(
					owner,
					state,
					"fixture-code",
					"https://attacker.example",
				),
			).rejects.toThrow("could not be completed");
			expect(fixture.tokenRequests()).toBe(0);
			await connect();
			await expect(
				service.begin(owner, connectionId, undefined),
			).rejects.toThrow("Confirm replacement");
		});
		it("requires reconnection after an uncertain refresh exchange", async () => {
			await connect();
			const provider = service.runtimeProvider(connectionId, fixture.server);
			await provider.token();
			failureMode = "network";
			await expect(provider.onUnauthorized()).rejects.toThrow("Reconnect");
			expect(
				(
					await pool.query("select status from connections where id=$1", [
						connectionId,
					])
				).rows[0].status,
			).toBe("needs reconnection");
			const attempts = failedRequests;
			failureMode = "";
			await expect(provider.token()).rejects.toThrow("Reconnect");
			expect(failedRequests).toBe(attempts);
		});
		it("stops a revoked grant until explicit reconnection without repeated refresh attempts", async () => {
			await connect();
			const provider = service.runtimeProvider(connectionId, fixture.server);
			await provider.token();
			failureMode = "invalid_grant";
			await expect(provider.onUnauthorized()).rejects.toThrow("Reconnect");
			expect(
				(
					await pool.query("select status from connections where id=$1", [
						connectionId,
					])
				).rows[0].status,
			).toBe("needs reconnection");
			expect(failedRequests).toBe(1);
			await expect(provider.token()).rejects.toThrow("Reconnect");
			expect(failedRequests).toBe(1);
		});
		it("keeps a newer sign-in when the previous grant's refresh fails late", async () => {
			await connect();
			const provider = service.runtimeProvider(connectionId, fixture.server);
			await provider.token();
			failureMode = "invalid_grant";
			duringFailedRefresh = async () => {
				// The user signs in again while the old grant's refresh is still in flight.
				const fresh = randomUUID();
				await pool.query(
					'insert into upstream_oauth_grants(id,"encryptedData") values($1,$2)',
					[fresh, box.encrypt({})],
				);
				await pool.query(
					'update connection_oauth set "grantId"=$2 where "connectionId"=$1',
					[connectionId, fresh],
				);
			};
			await expect(provider.onUnauthorized()).rejects.toThrow("Reconnect");
			expect(
				(
					await pool.query("select status from connections where id=$1", [
						connectionId,
					])
				).rows[0].status,
			).toBe("authenticated");
		});
		it("leaves a connection that was never signed in asking for sign-in", async () => {
			const provider = service.runtimeProvider(connectionId, fixture.server);
			await expect(provider.token()).rejects.toThrow("Reconnect");
			expect(
				(
					await pool.query("select status from connections where id=$1", [
						connectionId,
					])
				).rows[0].status,
			).toBe("authentication required");
		});
		it.each(["refused", "policy"] as const)(
			"requires reconnection when network policy refuses refresh (%s)",
			async (mode) => {
				await connect();
				const provider = service.runtimeProvider(connectionId, fixture.server);
				await provider.token();
				failureMode = mode;
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					await expect(provider.onUnauthorized()).rejects.toThrow("Reconnect");
				} finally {
					warn.mockRestore();
				}
				expect(
					(
						await pool.query("select status from connections where id=$1", [
							connectionId,
						])
					).rows[0].status,
				).toBe("needs reconnection");
				await expect(provider.token()).rejects.toThrow("Reconnect");
			},
		);
		it("logs callback failures by class without codes, state or provider text", async () => {
			const state = await begin();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await expect(
					service.finish(
						owner,
						state,
						"synthetic-code-secret",
						"https://attacker.example",
					),
				).rejects.toThrow("could not be completed");
				expect(warn).toHaveBeenCalled();
				const logged = JSON.stringify(warn.mock.calls);
				expect(logged).toContain("MCP sign-in could not complete");
				for (const secret of [state, "synthetic-code-secret", "attacker"])
					expect(logged).not.toContain(secret);
			} finally {
				warn.mockRestore();
			}
		});
		it("serializes concurrent refreshes and concurrent unauthorized retries", async () => {
			await connect();
			const {
				rows: [row],
			} = await pool.query(
				'select g.id,g."encryptedData" from upstream_oauth_grants g join connection_oauth c on c."grantId"=g.id where c."connectionId"=$1',
				[connectionId],
			);
			const data = box.decrypt<Record<string, unknown>>(row.encryptedData);
			data.expiresAt = Date.now() - 1;
			await pool.query(
				'update upstream_oauth_grants set "encryptedData"=$2 where id=$1',
				[row.id, box.encrypt(data)],
			);
			const providers = Array.from({ length: 12 }, () =>
				service.runtimeProvider(connectionId, fixture.server),
			);
			expect(
				await Promise.all(providers.map((provider) => provider.token())),
			).toEqual(Array(12).fill("fixture-access-2"));
			expect(fixture.tokenRequests()).toBe(2);
			await Promise.all(providers.map((provider) => provider.onUnauthorized()));
			expect(fixture.tokenRequests()).toBe(3);
			expect(await defined(providers[0]).token()).toBe("fixture-access-3");
		});
	},
);
