import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInstanceUpstreamOAuth } from "../apps/web/src/server/upstream";
import { createAuth, secretBox } from "../packages/auth/src/index";
import { authSchema } from "../packages/database/src/index";
import {
	authorizeUpstream,
	type UpstreamOAuthData,
} from "../packages/gateway/src/oauth";
import { createAccountTestDatabase } from "./account-database";
import { defined } from "./assertions";
import { oauthFixture } from "./oauth-fixture";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
describe.skipIf(!process.env.TEST_DATABASE_URL)(
	"isolated PostgreSQL OAuth refresh pools",
	() => {
		let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
		const services: ReturnType<typeof createInstanceUpstreamOAuth>[] = [];
		beforeAll(async () => {
			storage = await createAccountTestDatabase();
		});
		afterAll(async () => {
			await Promise.all(services.map((s) => s.close()));
			await storage?.close();
		});
		it("keeps app queries available under saturation and serializes shared rotating grants across independent services", async () => {
			const box = secretBox(randomBytes(32).toString("hex")),
				f = oauthFixture();
			await authorizeUpstream(f.provider(), {
				serverUrl: f.server,
				fetchFn: f.request,
				forceReauthorization: true,
			});
			await authorizeUpstream(f.provider(), {
				serverUrl: f.server,
				fetchFn: f.request,
				authorizationCode: "fixture-code",
				iss: f.issuer,
			});
			const data = f.saved();
			data.expiresAt = Date.now() - 1;
			const owner = randomUUID(),
				grant = randomUUID(),
				connectionIds = [randomUUID(), randomUUID()];
			await storage.pool.query(
				'insert into "user"(id,name,email) values($1,$1,$2)',
				[owner, `${owner}@test.invalid`],
			);
			await storage.pool.query(
				'insert into upstream_oauth_grants(id,"encryptedData") values($1,$2)',
				[grant, box.encrypt(data)],
			);
			for (const id of connectionIds) {
				await storage.pool.query(
					`insert into connections(id,"ownerId",label,url,transport,authentication,status,"encryptedHeaders") values($1,$2,$1,$3,'http','oauth','authenticated',$4)`,
					[id, owner, f.server, box.encrypt({})],
				);
				await storage.pool.query(
					'insert into connection_oauth("connectionId","grantId") values($1,$2)',
					[id, grant],
				);
			}
			const entered = deferred(),
				release = deferred();
			let refreshes = 0,
				currentRefresh = "fixture-refresh";
			const refresh: typeof fetch = async (input, init) => {
				if (String(input).endsWith("/token")) {
					refreshes++;
					expect(
						new URLSearchParams(String(init?.body)).get("refresh_token"),
					).toBe(currentRefresh);
					entered.resolve();
					await release.promise;
					currentRefresh = `rotated-${refreshes}`;
					return Response.json({
						access_token: `access-${refreshes}`,
						refresh_token: currentRefresh,
						token_type: "Bearer",
						expires_in: 3600,
					});
				}
				return f.request(input, init);
			};
			// Separate instances own separate lock pools; the PostgreSQL grant lock serializes their transactions.
			for (let i = 0; i < 2; i++)
				services.push(
					createInstanceUpstreamOAuth({
						pool: storage.pool,
						box,
						baseURL: "http://gateway.localhost",
						fetch: refresh,
						validateDestination: async () => {},
						authorize: async () => ({ url: f.server }),
					}),
				);
			const providers = Array.from({ length: 24 }, (_, i) =>
				defined(services[i % 2]).runtimeProvider(
					defined(connectionIds[i % 2]),
					f.server,
				),
			);
			const pending = Promise.all(providers.map((p) => p.token()));
			try {
				await entered.promise;
				// More blocked requests than the ten-connection app pool; an unrelated query must finish before refresh is released.
				await vi.waitFor(
					async () => {
						expect(
							(await storage.pool.query("select 42 as answer")).rows[0].answer,
						).toBe(42);
					},
					{ timeout: 1000 },
				);
				const {
					rows: [lease],
				} = await storage.pool.query(
					'select "refreshPending" from upstream_oauth_grants where id=$1',
					[grant],
				);
				expect(lease.refreshPending).toBe(true);
				release.resolve();
				expect(await pending).toEqual(Array(24).fill("access-1"));
				expect(refreshes).toBe(1);
				await Promise.all(providers.map((p) => p.onUnauthorized()));
				expect(refreshes).toBe(2);
				const {
					rows: [saved],
				} = await storage.pool.query(
					'select "encryptedData" from upstream_oauth_grants where id=$1',
					[grant],
				);
				expect(
					box.decrypt<UpstreamOAuthData>(saved.encryptedData).tokens
						?.refresh_token,
				).toBe("rotated-2");
				await storage.pool.query(
					"update connections set status='needs reconnection' where id=$1",
					[connectionIds[0]],
				);
				await expect(defined(providers[0]).token()).rejects.toThrow(
					"Reconnect",
				);
				expect(refreshes).toBe(2);
			} finally {
				release.resolve();
				await pending;
			}
		});
		it("uses injected social credentials through the real authorization handler", async () => {
			const auth = createAuth({
				database: storage.db,
				schema: authSchema,
				baseURL: "https://gateway.example",
				secret: randomBytes(32).toString("hex"),
				canRegister: async () => true,
				socialProviders: {
					github: {
						clientId: "injected-github",
						clientSecret: "fixture-github-secret",
					},
					google: {
						clientId: "injected-google",
						clientSecret: "fixture-google-secret",
					},
				},
			});
			for (const provider of ["github", "google"] as const) {
				const response = await auth.handler(
					new Request("https://gateway.example/api/auth/sign-in/social", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: "https://gateway.example",
						},
						body: JSON.stringify({
							provider,
							callbackURL: "https://gateway.example/app",
						}),
					}),
				);
				expect(response.status).toBe(200);
				const data = await response.json();
				expect(new URL(data.url).searchParams.get("client_id")).toBe(
					`injected-${provider}`,
				);
			}
		});
		it("migrates dashboard and retention indexes", async () => {
			const { rows } = await storage.pool.query(
				"select indexname,indexdef from pg_indexes where schemaname='public' and tablename='activity'",
			);
			expect(rows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						indexname: "activity_owner_created_at",
						indexdef: expect.stringContaining('("ownerId", "createdAt")'),
					}),
					expect.objectContaining({
						indexname: "activity_created_at",
						indexdef: expect.stringContaining('("createdAt")'),
					}),
				]),
			);
		});
	},
);
