import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createORPCClient,
	type RouterClient,
	RPCHandler,
	RPCLink,
} from "../apps/web/test-support/setup-rpc";
import bundledCatalog from "../packages/api/catalog/v1.json" with {
	type: "json",
};
import { parseCatalog } from "../packages/api/src/catalog-source";
import { createConnectorService } from "../packages/api/src/connector-server";
import { secretBox } from "../packages/auth/src/index";
import { withConnectorRequest } from "../packages/database/src/connector-catalog";
import { migrateDatabase } from "../packages/database/src/index";
import { createAccountTestDatabase } from "./account-database";
import { startFixture } from "./fixture";

// A synthetic host that resolves to the local fixture until `down` is set, counting every
// lookup made for it, so a test can prove that a step made no DNS or network request.
const dns = vi.hoisted(() => ({
	host: "replay.toolstile.test",
	down: false,
	lookups: 0,
}));
const unresolved = (hostname: string) =>
	Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
		code: "ENOTFOUND",
	});
vi.mock("node:dns/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns/promises")>();
	const lookup = (async (hostname: string, options: never) => {
		if (hostname !== dns.host) return actual.lookup(hostname, options);
		dns.lookups++;
		if (dns.down) throw unresolved(hostname);
		return [{ address: "127.0.0.1", family: 4 }];
	}) as typeof actual.lookup;
	return { ...actual, default: { ...actual, lookup }, lookup };
});
vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	const lookup = ((
		hostname: string,
		options: never,
		callback: (error: Error | null, entries?: unknown) => void,
	) => {
		if (hostname !== dns.host)
			return actual.lookup(hostname, options, callback);
		dns.lookups++;
		if (dns.down) callback(unresolved(hostname));
		else callback(null, [{ address: "127.0.0.1", family: 4 }]);
	}) as typeof actual.lookup;
	return { ...actual, default: { ...actual, lookup }, lookup };
});
describe.skipIf(!process.env.DATABASE_URL)(
	"connector catalog PostgreSQL + runtime + typed HTTP",
	() => {
		let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
		let runtime: typeof import("../apps/web/src/server/runtime");
		const owner = randomUUID(),
			other = randomUUID();
		const actor = { userId: owner, scopeId: owner };
		const bundled = required(parseCatalog(bundledCatalog)).entries;
		// Chosen by shape from the bundled snapshot, never by name.
		const seed = required(
			bundled.find(
				(entry) => !entry.fields.length && entry.authMethods.includes("bearer"),
			),
		);
		let fixture: Awaited<ReturnType<typeof startFixture>>;
		let api: RouterClient<
			typeof import("../apps/web/src/server/runtime").instanceRouter
		>;
		beforeAll(async () => {
			fixture = await startFixture();
			storage = await createAccountTestDatabase();
			await migrateDatabase(storage.db, {
				migrationsFolder: "apps/web/postgres-migrations",
			});
			vi.stubEnv("DATABASE_URL", storage.url);
			vi.stubEnv("BETTER_AUTH_URL", "http://localhost:4310");
			vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(64));
			vi.stubEnv("ENCRYPTION_KEY", "b".repeat(64));
			// Connection logos come from the bundled catalog snapshot, with no network request.
			vi.stubEnv("TOOLSTILE_CATALOG_FETCH", "off");
			runtime = await import("../apps/web/src/server/runtime");
			for (const id of [owner, other])
				await storage.pool.query(
					'insert into "user"(id,name,email) values($1,$1,$2)',
					[id, `${id}@test.invalid`],
				);
			const handler = new RPCHandler<{
				actor: typeof actor;
				services: typeof runtime.services;
			}>(runtime.instanceRouter);
			api = createORPCClient(
				new RPCLink({
					url: "http://localhost/api/rpc",
					fetch: async (input, init) => {
						const result = await handler.handle(new Request(input, init), {
							prefix: "/api/rpc",
							context: { actor, services: runtime.services },
						});
						return result.response ?? new Response(null, { status: 404 });
					},
				}),
			);
		});
		afterAll(async () => {
			await fixture?.close().catch(() => {});
			await runtime?.pool.end();
			await storage?.close();
			vi.unstubAllEnvs();
		});
		it("serves the dashboard catalog from the catalog source, with the legacy tables dropped", async () => {
			// A later migration dropped the tables earlier releases seeded.
			const legacy = await storage.pool.query(
				"select tablename as name from pg_tables where schemaname='public' and tablename in ('connector_catalog','connector_catalog_versions','connector_catalog_inventory')",
			);
			expect(legacy.rows).toEqual([]);
			const entries = await api.connectorCatalog();
			expect(entries.map((entry) => entry.slug)).toEqual(
				bundled.map((entry) => entry.slug),
			);
			expect(entries.find((entry) => entry.slug === seed.slug)?.name).toBe(
				seed.name,
			);
			expect(JSON.stringify(entries)).not.toMatch(
				/registeredClient|toolSnapshot/,
			);
			const withSnapshot = required(
				bundled.find((entry) => entry.toolSnapshot),
			);
			expect(
				await api.connectorInventory({ connectorId: withSnapshot.slug }),
			).toEqual(withSnapshot.toolSnapshot);
		});
		it("serves reviewed starters for the entry a URL display-matches", async () => {
			const entry = required(bundled.find((item) => item.starters));
			const starters = required(entry.starters);
			const endpoint = new URL(entry.endpoint);
			endpoint.searchParams.set("setting", "1");
			for (const url of [entry.endpoint, endpoint.href])
				expect(await api.connectorStarters({ url }), url).toEqual(starters);
			// The connection's stored catalog ID no longer selects starters.
			expect(
				await api.connectorStarters({
					connectorId: entry.slug,
					url: "https://unrelated.example.test/mcp",
				}),
			).toEqual([]);
		});
		it("previews an address without saving anything, including the /mcp probe", async () => {
			const service = createConnectorService({
				source: {
					read: async () => ({
						origin: "snapshot",
						generatedAt: "",
						entries: [],
					}),
				},
				key: "k",
				authorize: async () => {
					throw new Error("denied");
				},
				preview: async () => {
					throw new Error("must not preview");
				},
				create: async () => {
					throw new Error("must not create");
				},
			});
			await expect(service.catalog(actor)).rejects.toThrow("denied");
			await expect(service.preview(actor, fixture.url)).rejects.toThrow(
				"denied",
			);
			const origin = new URL(fixture.url).origin;
			expect(await api.previewConnection({ url: fixture.url })).toEqual({
				url: fixture.url,
				transport: "http",
				authentication: "headers",
				status: "reachable",
			});
			// A bare origin that does not answer is found at a common path.
			const server = await pathServer((path) => (path === "/mcp" ? 0 : 404));
			try {
				expect((await api.previewConnection({ url: server.origin })).url).toBe(
					`${server.origin}/mcp`,
				);
			} finally {
				await server.close();
			}
			expect(origin).toMatch(/^http:/);
			expect(
				(
					await storage.pool.query(
						'select count(*) n from connections where "ownerId"=$1',
						[owner],
					)
				).rows[0].n,
			).toBe(0);
		});
		it("checks and saves exactly the confirmed URL, never another path", async () => {
			// Answers 404 everywhere and records every path it was asked for.
			const server = await pathServer(() => 404);
			try {
				const confirmed = `${server.origin}/custom?b=2&a=1`;
				await expect(
					api.connectConnector({
						requestId: randomUUID(),
						url: confirmed,
						transport: "http",
						authentication: "headers",
					}),
				).rejects.toMatchObject({ code: "BAD_GATEWAY" });
				// A real request was made although transport and authentication were explicit.
				expect(server.paths.length).toBeGreaterThan(0);
				expect(new Set(server.paths)).toEqual(new Set(["/custom?b=2&a=1"]));
			} finally {
				await server.close();
			}
			expect(
				(
					await storage.pool.query(
						'select count(*) n from connections where "ownerId"=$1',
						[owner],
					)
				).rows[0].n,
			).toBe(0);
		});
		it("creates one encrypted connection for concurrent retries, without granting any agent access", async () => {
			const request = {
				requestId: randomUUID(),
				url: fixture.url,
				authentication: "headers" as const,
				transport: "sse" as const,
				headers: { Authorization: "Bearer catalog-synthetic-token" },
				label: "Fixture",
				suggestionId: seed.slug,
			};
			// The fixture speaks Streamable HTTP only, so the person's SSE choice fails its check.
			await expect(api.connectConnector(request)).rejects.toMatchObject({
				code: "BAD_GATEWAY",
			});
			const confirmed = { ...request, transport: "http" as const };
			const results = await Promise.all(
				Array.from({ length: 8 }, () => api.connectConnector(confirmed)),
			);
			expect(new Set(results.map((result) => result.id)).size).toBe(1);
			expect(results[0]).toMatchObject({
				url: fixture.url,
				transport: "http",
				authentication: "headers",
				status: "reachable",
			});
			const rows = await storage.pool.query(
				'select * from connections where "ownerId"=$1',
				[owner],
			);
			expect(rows.rows).toHaveLength(1);
			const row = rows.rows[0];
			expect(row.url).toBe(fixture.url);
			expect(row.label).toBe("Fixture");
			// The hint is kept only for a URL that display-matches that entry.
			expect(row.connectorId).toBeNull();
			expect(row).not.toHaveProperty("connectorRevision");
			expect(secretBox("b".repeat(64)).decrypt(row.encryptedHeaders)).toEqual({
				Authorization: "Bearer catalog-synthetic-token",
			});
			expect(JSON.stringify(await api.snapshot())).not.toContain(
				"catalog-synthetic-token",
			);
			expect((await api.snapshot()).grants).toEqual([]);
			const saved = await storage.pool.query(
				"select * from connector_requests where owner_id=$1",
				[owner],
			);
			expect(JSON.stringify(saved.rows)).not.toContain(
				"catalog-synthetic-token",
			);
			// Display hints are not part of the request; any setting that is conflicts.
			expect(
				(
					await api.connectConnector({
						...confirmed,
						suggestionId: undefined,
						label: "Renamed",
					})
				).id,
			).toBe(row.id);
			for (const changed of [
				{ headers: { Authorization: "Bearer different" } },
				{ url: `${fixture.url}?other=1` },
				{ authentication: "oauth" as const },
				{ transport: undefined },
			])
				await expect(
					api.connectConnector({ ...confirmed, ...changed }),
					JSON.stringify(changed),
				).rejects.toMatchObject({ code: "CONFLICT" });
			expect(
				(await runtime.services.snapshot({ userId: other, scopeId: other }))
					.connections,
			).toHaveLength(0);
			await runtime.services.removeConnection(actor, row.id);
			await expect(api.connectConnector(confirmed)).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});
		it("replays a created connection even when the server no longer answers", async () => {
			const server = await startFixture();
			const request = {
				requestId: randomUUID(),
				url: server.url,
				authentication: "oauth" as const,
			};
			const created = await api.connectConnector(request);
			expect(created.status).toBe("authentication required");
			await server.close();
			expect(await api.connectConnector(request)).toEqual(created);
			await expect(
				api.connectConnector({ ...request, requestId: randomUUID() }),
			).rejects.toMatchObject({ code: "BAD_GATEWAY" });
			await runtime.services.removeConnection(actor, created.id);
		});
		it("replays a created connection before any check, with no DNS or server request", async () => {
			const server = await pathServer(() => 0);
			const port = new URL(server.origin).port;
			const request = {
				requestId: randomUUID(),
				url: `http://${dns.host}:${port}/mcp`,
				transport: "http" as const,
				authentication: "headers" as const,
				headers: { Authorization: "Bearer replay-synthetic-token" },
			};
			try {
				const created = await api.connectConnector(request);
				expect(created.status).toBe("reachable");
				expect(server.paths.length).toBeGreaterThan(0);
				expect(dns.lookups).toBeGreaterThan(0);
				const seen = { paths: server.paths.length, lookups: dns.lookups };
				// The server still answers, yet a replay neither resolves nor contacts it.
				expect(await api.connectConnector(request)).toEqual(created);
				dns.down = true;
				expect(await api.connectConnector(request)).toEqual(created);
				// Conflicts are decided before any check too.
				await expect(
					api.connectConnector({
						...request,
						headers: { Authorization: "Bearer different" },
					}),
				).rejects.toMatchObject({ code: "CONFLICT" });
				expect({
					paths: server.paths.length,
					lookups: dns.lookups,
				}).toEqual(seen);
				// A new request still runs the real check, which fails while DNS is down.
				await expect(
					api.connectConnector({ ...request, requestId: randomUUID() }),
				).rejects.toThrow();
				expect(dns.lookups).toBeGreaterThan(seen.lookups);
				await runtime.services.removeConnection(actor, created.id);
			} finally {
				dns.down = false;
				await server.close();
			}
		});
		it("replays a created connection even when its destination is now refused", async () => {
			const request = {
				requestId: randomUUID(),
				url: fixture.url,
				authentication: "headers" as const,
			};
			const created = await api.connectConnector(request);
			// The same failure path as a DNS outage: validation throws before any check.
			await storage.pool.query(
				`insert into instance_settings(id,"allowPrivateNetwork") values('instance',false) on conflict(id) do update set "allowPrivateNetwork"=false`,
			);
			try {
				expect(await api.connectConnector(request)).toEqual(created);
				await expect(
					api.connectConnector({ ...request, requestId: randomUUID() }),
				).rejects.toThrow();
			} finally {
				await storage.pool.query(
					`update instance_settings set "allowPrivateNetwork"=true where id='instance'`,
				);
			}
			await runtime.services.removeConnection(actor, created.id);
		});
		it("uses a single transaction connection for deduplication and rolls back failures", async () => {
			const request = { requestId: randomUUID(), fingerprint: "fixture" };
			let created = 0;
			await expect(
				storage.db.transaction((tx) =>
					withConnectorRequest(
						tx,
						actorToIdentity(),
						request,
						async () => {
							created++;
							throw new Error("rollback");
						},
						async () => true,
					),
				),
			).rejects.toThrow("rollback");
			const run = () =>
				storage.db.transaction((tx) =>
					withConnectorRequest(
						tx,
						actorToIdentity(),
						request,
						async () => ({ id: String(++created) }),
						async () => true,
					),
				);
			const result = await run();
			expect(await run()).toEqual(result);
			expect(created).toBe(2);
		});
		function actorToIdentity() {
			return { ownerId: owner, scopeId: owner };
		}
	},
);
/** A local HTTP server answering each path with a status (0 hands it to the MCP fixture). */
async function pathServer(status: (path: string) => number) {
	const fixture = await startFixture();
	const paths: string[] = [];
	const http = createServer(async (incoming, outgoing) => {
		const path = incoming.url ?? "/";
		paths.push(path);
		const code = status(new URL(path, "http://x").pathname);
		if (code) {
			outgoing.writeHead(code);
			outgoing.end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const hop = ["host", "connection", "transfer-encoding", "content-length"];
		const headers = Object.fromEntries(
			Object.entries(incoming.headers).flatMap(([key, value]) =>
				typeof value === "string" && !hop.includes(key) ? [[key, value]] : [],
			),
		);
		const response = await fetch(fixture.url, {
			method: incoming.method,
			headers,
			...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
		});
		const reply = Object.fromEntries(
			[...response.headers].filter(([key]) => !hop.includes(key)),
		);
		outgoing.writeHead(response.status, reply);
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const address = http.address();
	if (!address || typeof address === "string") throw new Error("No address");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		paths,
		close: async () => {
			await new Promise<void>((resolve) => http.close(() => resolve()));
			await fixture.close();
		},
	};
}
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture");
	return value;
}
