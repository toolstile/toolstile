import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCatalogSnapshot } from "../apps/web/scripts/catalog-v1";
import bundledCatalog from "../packages/api/catalog/v1.json" with {
	type: "json",
};
import { bundledCatalogSnapshot } from "../packages/api/src/catalog-snapshot";
import {
	type CatalogFetchPolicy,
	type CatalogSnapshot,
	catalogLogoLocation,
	catalogLogoUrl,
	catalogSettings,
	catalogSourceFor,
	createCatalogFetchPolicy,
	createCatalogSource,
	matchCatalogEntry,
	parseCatalog,
	pullCatalog,
} from "../packages/api/src/catalog-source";
import { connectorLogoResponse } from "../packages/api/src/connector-logos";
import { connectionLogos } from "../packages/api/src/connector-server";
import { DestinationError } from "../packages/gateway/src/network";
import publishedCatalog from "./fixtures/published-catalog-v1.json" with {
	type: "json",
};

const catalogUrl = "https://catalog.example.test/catalog/v1.json";
const svg =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>';
const otherSvg = svg.replace("h8v8", "h4v4");
const sha = (body: string | Uint8Array) =>
	createHash("sha256").update(body).digest("hex");
const entry = (slug: string, overrides: Record<string, unknown> = {}) => ({
	slug,
	name: `Entry ${slug}`,
	publisher: "Example",
	description: "An example server.",
	categories: ["development"],
	keywords: ["example"],
	capabilities: [],
	documentation: "https://example.test/docs",
	endpoint: `https://${slug}.example.test/mcp`,
	authMethods: ["none"],
	requirements: "",
	listed: true,
	...overrides,
});
const document = (
	entries: unknown[],
	generatedAt = "2026-10-01T00:00:00Z",
) => ({
	version: 1,
	generatedAt,
	entries,
});
const snapshotOf = (
	entries: unknown[],
	files: Record<string, string> = {},
): (() => CatalogSnapshot) => {
	const snapshot: CatalogSnapshot = {
		catalog: document(entries, "2026-01-01T00:00:00Z"),
		logo: (hash) =>
			files[hash] === undefined ? undefined : Buffer.from(files[hash]),
	};
	return () => snapshot;
};
const emptySnapshot = snapshotOf([entry("bundled")]);

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
/** A fetch policy stub that records every request. */
function stubPolicy(handler: Handler) {
	const calls: { url: string; headers: Headers }[] = [];
	const policy: CatalogFetchPolicy = {
		fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
			calls.push({ url: String(input), headers: new Headers(init.headers) });
			return handler(String(input), init);
		}) as typeof fetch,
	};
	return { policy, calls };
}
const json = (body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json", ...headers },
	});
const sources: { stop(): void }[] = [];
function source(options: Partial<Parameters<typeof createCatalogSource>[0]>) {
	const created = createCatalogSource({
		url: catalogUrl,
		enabled: true,
		snapshot: emptySnapshot,
		fetchPolicy: stubPolicy(() => json(document([]))).policy,
		...options,
	});
	sources.push(created);
	return created;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slugs = (view: { entries: { slug: string }[] }) =>
	view.entries.map((item) => item.slug);
afterEach(() => {
	for (const item of sources.splice(0)) item.stop();
	vi.restoreAllMocks();
});

describe("v1 catalog schema", () => {
	it("accepts published producer bytes with omitted visibility and null inventories", () => {
		const parsed = parseCatalog(publishedCatalog);
		expect(parsed?.dropped).toBe(0);
		expect(parsed?.entries.map((item) => item.slug)).toEqual(
			publishedCatalog.entries.map((item) => item.slug),
		);
		expect(parsed?.entries.every((item) => item.listed)).toBe(true);
		expect(parsed?.entries[1].toolSnapshot).toBeUndefined();
		expect(
			parseCatalog({
				...publishedCatalog,
				entries: publishedCatalog.entries.map((item) => ({
					...item,
					listed: false,
				})),
			})?.entries,
		).toEqual([]);
	});
	it("drops invalid entries one by one, ignores unknown fields and leaves out unlisted ones", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const parsed = parseCatalog(
			document([
				entry("kept", { futureField: { nested: true } }),
				entry("operator-client", {
					registeredClient: { env: "GITHUB_MCP" },
				}),
				entry("remote-regex", {
					fields: [
						{
							name: "project_ref",
							label: "Project",
							help: "",
							kind: "text",
							pattern: "(a+)+$",
						},
					],
				}),
				entry("Bad Slug"),
				entry("plain-http", { endpoint: "http://plain.example.test/mcp" }),
				entry("bad-kind", {
					fields: [{ name: "x", label: "X", help: "", kind: "regex" }],
				}),
				entry("hidden", { listed: false }),
				entry("kept", { name: "Duplicate" }),
				"not an object",
			]),
		);
		expect(parsed?.entries.map((item) => item.slug)).toEqual(["kept"]);
		expect(parsed?.entries[0]).not.toHaveProperty("futureField");
		expect(parsed?.dropped).toBe(7);
		expect(parseCatalog({ version: 2, entries: [] })).toBeUndefined();
		expect(parseCatalog(document([]).entries)).toBeUndefined();
	});
	it("accepts identifier, boolean and text fields with no pattern", () => {
		const parsed = parseCatalog(
			document([
				entry("fields", {
					fields: [
						{ name: "project_ref", label: "Ref", help: "", kind: "identifier" },
						{
							name: "read_only",
							label: "Read only",
							help: "",
							kind: "boolean",
						},
					],
				}),
			]),
		);
		expect(parsed?.entries[0].fields).toEqual([
			{
				name: "project_ref",
				label: "Ref",
				help: "",
				kind: "identifier",
				required: false,
			},
			{
				name: "read_only",
				label: "Read only",
				help: "",
				kind: "boolean",
				required: false,
			},
		]);
	});
	it("reads settings from the environment", () => {
		expect(catalogSettings({})).toEqual({
			url: "https://www.toolstile.com/catalog/v1.json",
			enabled: true,
		});
		expect(
			catalogSettings({
				TOOLSTILE_CATALOG_URL: catalogUrl,
				TOOLSTILE_CATALOG_FETCH: "off",
			}),
		).toEqual({ url: catalogUrl, enabled: false });
	});
});

describe("catalog source", () => {
	it("keeps the last good copy, renews it on 304 and never awaits the network once warm", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let mode: "ok" | "fail" | "not-modified" = "ok";
		const { policy, calls } = stubPolicy(() =>
			mode === "fail"
				? new Response("down", { status: 503 })
				: mode === "not-modified"
					? new Response(null, { status: 304 })
					: json(document([entry("remote")]), { ETag: '"v1"' }),
		);
		const catalog = source({ fetchPolicy: policy, ttlMs: 60_000 });
		const first = await catalog.read();
		expect(first.origin).toBe("remote");
		expect(slugs(first)).toEqual(["remote"]);
		expect(calls[0].headers.get("user-agent")).toMatch(/^Toolstile\/\d/);
		expect(calls[0].headers.has("cookie")).toBe(false);
		expect(calls[0].headers.has("if-none-match")).toBe(false);
		mode = "fail";
		await catalog.refresh();
		expect(slugs(await catalog.read())).toEqual(["remote"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
		mode = "not-modified";
		await catalog.refresh();
		expect(calls.at(-1)?.headers.get("if-none-match")).toBe('"v1"');
		expect(slugs(await catalog.read())).toEqual(["remote"]);
		// Within the TTL, reads start no request.
		const count = calls.length;
		await catalog.read();
		await catalog.read();
		expect(calls.length).toBe(count);
	});
	it("refreshes on the first read after the TTL and on its timer, one request at a time", async () => {
		let release: (() => void) | undefined;
		let generation = 0;
		const { policy, calls } = stubPolicy(async () => {
			generation++;
			if (generation === 2)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return json(document([entry(`gen-${generation}`)]));
		});
		const catalog = source({ fetchPolicy: policy, ttlMs: 40 });
		expect(slugs(await catalog.read())).toEqual(["gen-1"]);
		await sleep(50);
		// Expired: the read returns the last copy at once and starts one refresh.
		const reads = await Promise.all([
			catalog.read(),
			catalog.read(),
			catalog.read(),
		]);
		expect(reads.map(slugs)).toEqual([["gen-1"], ["gen-1"], ["gen-1"]]);
		await sleep(60);
		// The timer fired while the refresh was running: still a single request.
		expect(calls.length).toBe(2);
		release?.();
		await catalog.refresh();
		expect(slugs(await catalog.read())).toEqual(["gen-2"]);
		const idle = calls.length;
		await sleep(130);
		expect(calls.length).toBeGreaterThan(idle);
		catalog.stop();
		const stopped = calls.length;
		await sleep(100);
		expect(calls.length).toBe(stopped);
	});
	it("waits at most the budget on a cold start, then serves the snapshot", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { policy } = stubPolicy(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) =>
					init.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					),
				),
		);
		const catalog = source({ fetchPolicy: policy, budgetMs: 80 });
		const started = performance.now();
		const view = await catalog.read();
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(view.origin).toBe("snapshot");
		expect(slugs(view)).toEqual(["bundled"]);
		// Later reads do not wait again.
		const again = performance.now();
		await catalog.read();
		expect(performance.now() - again).toBeLessThan(50);
		const failing = source({
			fetchPolicy: stubPolicy(() => {
				throw new TypeError("fetch failed");
			}).policy,
		});
		expect((await failing.read()).origin).toBe("snapshot");
	});
	it("settles a refresh stalled in DNS within the budget, then refreshes normally", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let stalled = true;
		const lookups: string[] = [];
		const policy = createCatalogFetchPolicy({
			resolve: (hostname) => {
				lookups.push(hostname);
				return stalled
					? new Promise(() => {})
					: Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
			},
		});
		const catalog = source({
			fetchPolicy: policy,
			budgetMs: 100,
			ttlMs: 60_000,
		});
		const started = performance.now();
		await catalog.refresh();
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
		// The single-flight refresh settled, so the next one runs (and reaches DNS again).
		stalled = false;
		await catalog.refresh();
		expect(lookups.length).toBe(2);
		// Responses that arrive after their deadlines are released, never left unread.
		const cancelled: number[] = [];
		const lateResponses: Promise<unknown>[] = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		let call = 0;
		const lateness = source({
			budgetMs: 40,
			fetchPolicy: stubPolicy(() => {
				const index = ++call;
				if (index > 3) return json(document([entry("on-time")]));
				const late = sleep(80).then(() =>
					index === 3
						? Promise.reject(new Error("late failure"))
						: new Response(
								new ReadableStream({
									cancel: () => void cancelled.push(index),
								}),
								{ status: 200 },
							),
				);
				lateResponses.push(late.catch(() => {}));
				return late;
			}).policy,
		});
		for (let attempt = 0; attempt < 3; attempt++) await lateness.refresh();
		await Promise.all(lateResponses);
		await sleep(10);
		process.off("unhandledRejection", onUnhandled);
		expect(cancelled.sort()).toEqual([1, 2]);
		expect(unhandled).toEqual([]);
		await lateness.refresh();
		expect(slugs(await lateness.read())).toEqual(["on-time"]);
		// A stub that ignores the signal also settles at the deadline.
		const ignoring = source({
			fetchPolicy: stubPolicy(() => new Promise<Response>(() => {})).policy,
			budgetMs: 100,
		});
		const again = performance.now();
		await ignoring.refresh();
		expect(performance.now() - again).toBeLessThan(1_000);
		const recovering = { stall: true };
		const { policy: flaky, calls } = stubPolicy(() =>
			recovering.stall
				? new Promise<Response>(() => {})
				: json(document([entry("recovered")])),
		);
		const later = source({ fetchPolicy: flaky, budgetMs: 100 });
		await later.refresh();
		recovering.stall = false;
		await later.refresh();
		expect(calls.length).toBe(2);
		expect(slugs(await later.read())).toEqual(["recovered"]);
	});
	it("makes no request with fetching off", async () => {
		const { policy, calls } = stubPolicy(() => json(document([])));
		const catalog = source({
			fetchPolicy: policy,
			enabled: false,
			snapshot: snapshotOf(
				[entry("bundled", { logo: { sha256: sha(svg), type: "svg" } })],
				{ [sha(svg)]: svg },
			),
		});
		const view = await catalog.read();
		await catalog.refresh();
		expect(view.origin).toBe("snapshot");
		expect(view.entries[0].logo?.sha256).toBe(sha(svg));
		expect(
			await catalog.logoFile("bundled", sha(svg).slice(0, 16), "svg"),
		).toBeDefined();
		expect(calls).toEqual([]);
	});
	it("treats redirects, oversized bodies and slow bodies as failures", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const failures: Handler[] = [
			() => new Response(null, { status: 302, headers: { Location: "/" } }),
			() =>
				new Response("x".repeat(1024 * 1024 + 1), {
					status: 200,
				}),
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new Uint8Array(64 * 1024));
						},
					}),
					{ status: 200 },
				),
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"version":1,'));
						},
					}),
					{ status: 200 },
				),
			() => json({ version: 1, generatedAt: "x", entries: [] }),
		];
		for (const handler of failures) {
			const catalog = source({
				fetchPolicy: stubPolicy(handler).policy,
				budgetMs: 150,
			});
			const started = performance.now();
			expect((await catalog.read()).origin).toBe("snapshot");
			expect(performance.now() - started).toBeLessThan(2_000);
		}
	});
	it("refuses private addresses and DNS answers that change to private at connection time", async () => {
		const privatePolicy = createCatalogFetchPolicy({
			resolve: async () => [{ address: "127.0.0.1", family: 4 }],
		});
		await expect(
			privatePolicy.fetch("https://catalog.example.test/catalog/v1.json"),
		).rejects.toThrow(DestinationError);
		await expect(
			createCatalogFetchPolicy().fetch("https://127.0.0.1/catalog/v1.json"),
		).rejects.toThrow(DestinationError);
		await expect(
			createCatalogFetchPolicy().fetch("https://[::1]/catalog/v1.json"),
		).rejects.toThrow(DestinationError);
		await expect(
			createCatalogFetchPolicy({
				resolve: async () => [{ address: "1.1.1.1", family: 4 }],
			}).fetch("http://catalog.example.test/v1.json"),
		).rejects.toThrow(DestinationError);
		let lookups = 0;
		const rebinding = createCatalogFetchPolicy({
			resolve: async () => [
				{ address: lookups++ === 0 ? "1.1.1.1" : "10.0.0.7", family: 4 },
			],
		});
		const error = await rebinding
			.fetch("https://rebind.example.test/catalog/v1.json")
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);
		expect(lookups).toBe(2);
		expect((error as Error).cause).toBeInstanceOf(DestinationError);
		// The source falls back to the snapshot and never accepts a bad URL.
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const catalog = source({ fetchPolicy: rebinding });
		expect((await catalog.read()).origin).toBe("snapshot");
		const { policy, calls } = stubPolicy(() => json(document([])));
		const misconfigured = source({
			url: "http://catalog.example.test/v1.json",
			fetchPolicy: policy,
		});
		expect((await misconfigured.read()).origin).toBe("snapshot");
		expect(calls).toEqual([]);
	});
	it("fetches logos from the catalog origin by sha and rejects mismatched or invalid files", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const scripted = svg.replace("<path", "<script>alert(1)</script><path");
		const notPng = "<svg>not a png</svg>";
		const served: Record<string, string> = {
			[`${sha(svg)}.svg`]: svg,
			[`${sha(otherSvg)}.svg`]: svg, // wrong bytes for this sha
			[`${sha(scripted)}.svg`]: scripted,
			[`${sha(notPng)}.png`]: notPng,
		};
		const { policy, calls } = stubPolicy((url) => {
			if (url === catalogUrl)
				return json(
					document([
						entry("good", { logo: { sha256: sha(svg), type: "svg" } }),
						entry("mismatch", {
							logo: { sha256: sha(otherSvg), type: "svg" },
						}),
						entry("scripted", {
							logo: { sha256: sha(scripted), type: "svg" },
						}),
						entry("wrong-type", {
							logo: { sha256: sha(notPng), type: "png" },
						}),
					]),
				);
			const name = url.split("/").pop() ?? "";
			return served[name] === undefined
				? new Response("missing", { status: 404 })
				: new Response(served[name], { status: 200 });
		});
		const catalog = source({ fetchPolicy: policy });
		const view = await catalog.read();
		expect(
			Object.fromEntries(
				view.entries.map((item) => [item.slug, catalogLogoUrl(item)]),
			),
		).toEqual({
			good: `/connector-logos/good-${sha(svg).slice(0, 16)}.svg`,
			mismatch: null,
			scripted: null,
			"wrong-type": null,
		});
		const logoRequests = calls.slice(1).map((call) => new URL(call.url));
		expect(logoRequests.length).toBe(4);
		for (const url of logoRequests) {
			expect(url.origin).toBe("https://catalog.example.test");
			expect(url.pathname).toMatch(
				/^\/catalog\/v1\/logos\/[0-9a-f]{64}\.(svg|png)$/,
			);
		}
		expect(
			await catalog.logoFile("mismatch", sha(otherSvg).slice(0, 16), "svg"),
		).toBeUndefined();
		const response = await connectorLogoResponse(
			catalog,
			new Request(`https://toolstile.test${catalogLogoUrl(view.entries[0])}`),
		);
		expect(await response.text()).toBe(svg);
		expect(
			catalogLogoLocation("https://catalog.example.test/v1.json?x=1", {
				sha256: sha(svg),
				type: "svg",
			}),
		).toBe(`https://catalog.example.test/v1/logos/${sha(svg)}.svg`);
	});
	it("is cached per process by URL, fetch setting and policy", () => {
		const policy = stubPolicy(() => json(document([]))).policy;
		const options = {
			url: catalogUrl,
			enabled: false,
			snapshot: emptySnapshot,
			fetchPolicy: policy,
		};
		const first = catalogSourceFor(options);
		expect(catalogSourceFor({ ...options })).toBe(first);
		expect(catalogSourceFor({ ...options, url: `${catalogUrl}?b` })).not.toBe(
			first,
		);
		expect(
			catalogSourceFor({
				...options,
				fetchPolicy: stubPolicy(() => json(document([]))).policy,
			}),
		).not.toBe(first);
	});
});

describe("display matching", () => {
	const entries = [
		entry("supabase", { endpoint: "https://mcp.supabase.com/mcp" }),
		entry("solo", { endpoint: "https://solo.example.test/v1/mcp" }),
		entry("shared-a", { endpoint: "https://shared.example.test/a" }),
		entry("shared-b", { endpoint: "https://shared.example.test/b/" }),
	];
	// Other matching rules are covered in connectors.test.ts.
	it("matches the exact path among entries sharing a host", () => {
		expect(
			matchCatalogEntry(entries, "https://shared.example.test/b")?.slug,
		).toBe("shared-b");
	});
	it("gives connection views the matched entry's logo URL", async () => {
		const catalog = source({
			enabled: false,
			snapshot: snapshotOf(
				[
					entry("logo-entry", { logo: { sha256: sha(svg), type: "svg" } }),
					entry("plain"),
				],
				{ [sha(svg)]: svg },
			),
		});
		const result = await connectionLogos(catalog, [
			{ url: "https://logo-entry.example.test/mcp/?x=1" },
			{ url: "https://plain.example.test/mcp" },
			{ url: "https://unknown.example.test/mcp" },
		]);
		expect(result.map((item) => item.logoUrl)).toEqual([
			`/connector-logos/logo-entry-${sha(svg).slice(0, 16)}.svg`,
			null,
			null,
		]);
		expect(await connectionLogos(catalog, [])).toEqual([]);
	});
});

describe("logo route", () => {
	it("serves logos only at their content-addressed URL, with immutable headers", async () => {
		const catalog = source({
			enabled: false,
			snapshot: snapshotOf(
				[entry("logo-route", { logo: { sha256: sha(svg), type: "svg" } })],
				{ [sha(svg)]: svg },
			),
		});
		const url =
			catalogLogoUrl({
				slug: "logo-route",
				logo: { sha256: sha(svg), type: "svg" },
			}) ?? "";
		expect(url).toBe(
			`/connector-logos/logo-route-${sha(svg).slice(0, 16)}.svg`,
		);
		const get = (path: string, method = "GET") =>
			connectorLogoResponse(
				catalog,
				new Request(`https://toolstile.test${path}`, { method }),
			);
		const response = await get(url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/svg+xml");
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
		);
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(await response.text()).toBe(svg);
		const head = await get(url, "HEAD");
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		for (const path of [
			url.replace(/-[0-9a-f]{16}\./, "-0000000000000000."),
			url.replace(".svg", ".png"),
			"/connector-logos/unknown-0123456789abcdef.svg",
			"/connector-logos/../etc",
		]) {
			const missing = await get(path);
			expect(missing.status, path).toBe(404);
			expect(missing.headers.get("cache-control")).toBe("no-store");
		}
	});
	it("keeps logo URLs from releases that hashed the inline logo resolving", async () => {
		const catalog = source({
			enabled: false,
			snapshot: () => bundledCatalogSnapshot,
		});
		const view = await catalog.read();
		const withLogos = view.entries.filter((item) => item.logo);
		expect(withLogos.some((item) => item.logo?.type === "png")).toBe(true);
		for (const item of withLogos) {
			const logo = item.logo as NonNullable<typeof item.logo>;
			const body = must(
				await bundledCatalogSnapshot.logo(logo.sha256, logo.type),
			);
			// Earlier releases hashed the SVG markup or the raster data URI.
			const legacy =
				logo.type === "svg"
					? Buffer.from(body).toString("utf8")
					: `data:image/${logo.type};base64,${Buffer.from(body).toString("base64")}`;
			for (const path of [
				`/connector-logos/${item.slug}-${sha(legacy).slice(0, 16)}.${logo.type}`,
				catalogLogoUrl(item),
			]) {
				const response = await connectorLogoResponse(
					catalog,
					new Request(`https://toolstile.test${path}`, { method: "HEAD" }),
				);
				expect(response.status, path ?? item.slug).toBe(200);
			}
		}
	});
	it("serves bundled raster logos without the SVG policy", async () => {
		const catalog = source({
			enabled: false,
			snapshot: () => bundledCatalogSnapshot,
		});
		const view = await catalog.read();
		const png = view.entries.find((item) => item.logo?.type === "png");
		expect(png).toBeDefined();
		const response = await connectorLogoResponse(
			catalog,
			new Request(`https://toolstile.test${catalogLogoUrl(png)}`),
		);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.has("content-security-policy")).toBe(false);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe("bundled snapshot", () => {
	it("validates on its own, whichever catalog it was pulled from", async () => {
		const raw = bundledCatalog.entries as { slug: string; listed: boolean }[];
		const parsed = parseCatalog(bundledCatalog);
		expect(parsed?.dropped).toBe(0);
		expect(parsed?.entries.length).toBeGreaterThan(0);
		// Every committed entry is valid and listed; hidden connectors are never bundled.
		expect(parsed?.entries.length).toBe(raw.length);
		expect(raw.every((item) => item.listed)).toBe(true);
		expect(raw.some((item) => ["figma", "ahrefs"].includes(item.slug))).toBe(
			false,
		);
		expect(JSON.stringify(bundledCatalog)).not.toContain("registeredClient");
		expect(JSON.stringify(bundledCatalog)).not.toContain('"pattern"');
		for (const item of parsed?.entries ?? []) {
			if (!item.logo) continue;
			const body = await bundledCatalogSnapshot.logo(
				item.logo.sha256,
				item.logo.type,
			);
			expect(body && sha(body), item.slug).toBe(item.logo.sha256);
		}
	});
	it("keeps Supabase's project_ref and read_only settings in the fields shape", () => {
		expect(
			parseCatalog(bundledCatalog)?.entries.find(
				(item) => item.slug === "supabase",
			)?.fields,
		).toEqual([
			expect.objectContaining({ name: "project_ref", kind: "identifier" }),
			expect.objectContaining({ name: "read_only", kind: "boolean" }),
		]);
	});
	it("is written only when it validates", async () => {
		const first = must(
			parseCatalog(bundledCatalog)?.entries.find((item) => item.logo),
		);
		const generated = {
			version: 1 as const,
			generatedAt: bundledCatalog.generatedAt,
			entries: [first],
		};
		await expect(
			writeCatalogSnapshot(
				{ ...generated, entries: [{ ...first, slug: "Bad" }] },
				new Map(),
				new URL("file:///nonexistent/"),
			),
		).rejects.toThrow("does not validate");
		await expect(
			writeCatalogSnapshot(
				generated,
				new Map(),
				new URL("file:///nonexistent/"),
			),
		).rejects.toThrow("logo file does not match");
	});
	it("pullCatalog rejects an invalid document and an insecure URL", async () => {
		await expect(
			pullCatalog({
				url: catalogUrl,
				fetchPolicy: stubPolicy(() => json({ version: 2 })).policy,
			}),
		).rejects.toThrow("not a valid v1 document");
		await expect(
			pullCatalog({
				url: "https://catalog.example.test:8443/v1.json",
				fetchPolicy: stubPolicy(() => json(document([]))).policy,
			}),
		).rejects.toThrow("port 443");
		const pulled = await pullCatalog({
			url: catalogUrl,
			fetchPolicy: stubPolicy((url) =>
				url === catalogUrl
					? json(
							document([
								entry("one", { logo: { sha256: sha(svg), type: "svg" } }),
							]),
						)
					: new Response(svg),
			).policy,
		});
		expect(pulled.document.entries[0].logo?.sha256).toBe(sha(svg));
		expect(pulled.logos.size).toBe(1);
	});
});

function must<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) throw new Error("Missing fixture");
	return value;
}
