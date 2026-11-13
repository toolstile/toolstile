import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createConnectorService,
	registeredClientFor,
	upstreamOAuthClients,
} from "../packages/api/src/connector-server";
import {
	applyCatalogFields,
	type CatalogEntry,
	type CatalogField,
	catalogEntry,
	connectorLogoProblem,
	matchCatalogEntry,
	searchConnectors,
} from "../packages/api/src/connectors";
import { connectConnectorInput } from "../packages/api/src/contract";

const svg =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>';
const synthetic = (patch: Partial<CatalogEntry> = {}): CatalogEntry =>
	catalogEntry.parse({
		slug: "example-tracker",
		featured: false,
		listed: true,
		name: "Example Tracker",
		publisher: "Example",
		description: "Track synthetic work items.",
		categories: ["development"],
		keywords: ["issue tracking", "tickets"],
		capabilities: ["Find items"],
		documentation: "https://docs.example.test/mcp",
		endpoint: "https://mcp.example.test/mcp/",
		authMethods: ["bearer", "oauth"],
		requirements: "An Example account.",
		fields: [],
		...patch,
	});
const tracker = synthetic();

describe("starter selections", () => {
	const starter = {
		id: "read",
		name: "Read items",
		description: "Find items.",
		allow: ["find_items"],
		requireApproval: ["save_item"],
	};
	it("validates the shape", () => {
		expect(synthetic({ starters: [starter] }).starters).toHaveLength(1);
		const valid = (starters: unknown[]) =>
			catalogEntry.safeParse({ ...tracker, starters }).success;
		expect(valid([starter])).toBe(true);
		// Approval-only starters are not allowed: each one allows at least one lookup.
		expect(valid([{ ...starter, allow: [] }])).toBe(false);
		expect(valid([{ ...starter, allow: ["save_item"] }])).toBe(false);
		expect(valid([starter, starter])).toBe(false);
		expect(valid([])).toBe(false);
	});
});

describe("connector logos", () => {
	it.each([
		["inline SVG", svg],
		[
			"SVG with a declaration and fragment reference",
			`<?xml version="1.0"?>\n<svg><use href="#a"/></svg>`,
		],
		["PNG data URI", "data:image/png;base64,iVBORw0KGgo="],
	])("accepts %s", (_, logo) => {
		expect(connectorLogoProblem(logo)).toBeUndefined();
	});
	it.each([
		["script", "<svg><script>alert(1)</script></svg>"],
		["event handler", '<svg onload="alert(1)"></svg>'],
		["external image", '<svg><image href="https://evil.test/x.png"/></svg>'],
		["javascript URL", '<svg><a href="javascript:alert(1)"/></svg>'],
		[
			"external stylesheet",
			"<svg><style>@import url(https://evil.test/a.css)</style></svg>",
		],
		["CSS URL", '<svg><rect style="fill:url(https://evil.test/p)"/></svg>'],
		["foreign object", "<svg><foreignObject/></svg>"],
		["entity", '<!DOCTYPE svg [<!ENTITY a "b">]><svg/>'],
		["not SVG", "<div></div>"],
		["SVG data URI", "data:image/svg+xml;base64,PHN2Zy8+"],
		["HTML data URI", "data:text/html;base64,PGI+"],
		["oversized", `data:image/png;base64,${"A".repeat(70_000)}`],
	])("rejects %s", (_, logo) => {
		expect(connectorLogoProblem(logo)).toBeDefined();
	});
});

describe("catalog entries", () => {
	it("rejects credentials in the endpoint, remote patterns and operator clients", () => {
		expect(() =>
			synthetic({ endpoint: "https://user:secret@example.com/mcp" }),
		).toThrow();
		expect(
			catalogEntry.safeParse({
				...tracker,
				fields: [
					{
						name: "ref",
						label: "Ref",
						help: "",
						kind: "text",
						pattern: ".*",
					},
				],
			}).success,
		).toBe(false);
		expect(
			catalogEntry.safeParse({ ...tracker, registeredClient: { env: "X" } })
				.success,
		).toBe(false);
		// Unknown fields are ignored.
		expect(
			catalogEntry.parse({ ...tracker, icon: "retired" }),
		).not.toHaveProperty("icon");
	});
	it("finds app names, keywords and tasks with filters", () => {
		const other = synthetic({
			slug: "example-notes",
			name: "Example Notes",
			keywords: ["wiki"],
			categories: ["productivity"],
			authMethods: ["oauth"],
		});
		const entries = [tracker, other];
		expect(
			searchConnectors(entries, { query: "EXAMPLE TRACKER" })[0]?.slug,
		).toBe(tracker.slug);
		expect(searchConnectors(entries, { query: "wiki" })[0]?.slug).toBe(
			other.slug,
		);
		expect(
			searchConnectors(entries, { query: "issue tracking" }).map((e) => e.slug),
		).toEqual([tracker.slug]);
		expect(
			searchConnectors(entries, { category: "productivity", auth: "oauth" }),
		).toEqual([other]);
		expect(searchConnectors(entries, { query: "no such connector" })).toEqual(
			[],
		);
	});
});

describe("catalog field values in the suggested URL", () => {
	const fields: CatalogField[] = [
		{
			name: "project_ref",
			label: "Project reference",
			help: "",
			required: false,
			kind: "identifier",
		},
		{
			name: "read_only",
			label: "Read-only access",
			help: "",
			required: false,
			kind: "boolean",
		},
		{ name: "note", label: "Note", help: "", required: false, kind: "text" },
	];
	const endpoint = "https://mcp.example.test/mcp?region=us";
	it("applies values as encoded query parameters and skips empty ones", () => {
		expect(applyCatalogFields(endpoint, fields, {})).toBe(endpoint);
		const url = new URL(
			applyCatalogFields(endpoint, fields, {
				project_ref: "abc_DEF-123",
				read_only: "true",
				note: "a&b=c d",
			}),
		);
		expect(url.searchParams.get("region")).toBe("us");
		expect(url.searchParams.get("project_ref")).toBe("abc_DEF-123");
		expect(url.searchParams.get("read_only")).toBe("true");
		// URLSearchParams encodes the value; it cannot add another parameter.
		expect(url.searchParams.get("note")).toBe("a&b=c d");
		expect([...url.searchParams.keys()]).toEqual([
			"region",
			"project_ref",
			"read_only",
			"note",
		]);
	});
	it("uses the fixed identifier check, never a remote pattern", () => {
		for (const project_ref of [
			"../../elsewhere",
			"abc/def",
			"a b",
			"x".repeat(129),
		])
			expect(
				() => applyCatalogFields(endpoint, fields, { project_ref }),
				project_ref,
			).toThrow("letters, digits");
		expect(() =>
			applyCatalogFields(endpoint, fields, { read_only: "yes" }),
		).toThrow();
		expect(() =>
			applyCatalogFields(
				endpoint,
				[{ ...fields[0], required: true } as CatalogField],
				{},
			),
		).toThrow("required");
	});
	it("refuses an address longer than a typed one may be", () => {
		expect(() =>
			applyCatalogFields(
				`https://mcp.example.test/${"a".repeat(2000)}`,
				fields,
				{
					note: "b".repeat(100),
				},
			),
		).toThrow("2,048 characters");
	});
});

describe("display matching", () => {
	const entries = [
		{ slug: "tracker", endpoint: "https://mcp.example.test/MCP/" },
		{ slug: "notes", endpoint: "https://notes.example.test/mcp" },
		{ slug: "notes-v2", endpoint: "https://notes.example.test/v2" },
	];
	it("matches lowercase origin and path, ignoring the query and a trailing slash", () => {
		for (const url of [
			"https://mcp.example.test/mcp",
			"https://MCP.example.test/mcp/?region=us",
			"https://mcp.example.test/Mcp",
		])
			expect(matchCatalogEntry(entries, url)?.slug, url).toBe("tracker");
	});
	it("falls back to the host only when exactly one entry has it", () => {
		expect(
			matchCatalogEntry(entries, "https://mcp.example.test/other")?.slug,
		).toBe("tracker");
		expect(
			matchCatalogEntry(entries, "https://notes.example.test/other"),
		).toBeUndefined();
		for (const url of [
			"https://mcp.example.test.attacker.test/mcp",
			"https://mcp.example.test:8443/mcp",
			"http://mcp.example.test/mcp",
			"https://name@mcp.example.test/mcp",
			"not a url",
		])
			expect(matchCatalogEntry(entries, url), url).toBeUndefined();
	});
});

describe("confirmed connection requests", () => {
	const request = {
		requestId: randomUUID(),
		url: "https://mcp.example.test/mcp?project_ref=abc",
		authentication: "headers",
		headers: { Authorization: "Bearer synthetic-secret" },
		suggestionId: "example-tracker",
	};
	it("takes the confirmed URL and no catalog identity or settings", () => {
		expect(connectConnectorInput.parse(request)).toMatchObject({
			url: request.url,
			authentication: "headers",
		});
		for (const extra of [
			{ connectorId: "example-tracker" },
			{ revision: 1 },
			{ configuration: { project_ref: "abc" } },
			{ apiKey: "x" },
		])
			expect(
				connectConnectorInput.safeParse({ ...request, ...extra }).success,
				JSON.stringify(extra),
			).toBe(false);
		expect(
			connectConnectorInput.safeParse({ ...request, authentication: "auto" })
				.success,
		).toBe(false);
		expect(
			connectConnectorInput.safeParse({
				...request,
				suggestionId: "Not A Slug",
			}).success,
		).toBe(false);
	});
});

describe("confirmed request fingerprints and hints", () => {
	const service = (entries: { slug: string; endpoint: string }[]) =>
		createConnectorService({
			source: {
				read: async () =>
					({ origin: "snapshot", generatedAt: "", entries }) as never,
			},
			key: "synthetic-key",
			authorize: async () => {},
			preview: async () => {
				throw new Error("unused");
			},
			create: async () => {
				throw new Error("unused");
			},
		});
	const actor = { userId: "u", scopeId: "u" };
	const base = {
		requestId: randomUUID(),
		url: "https://mcp.example.test/mcp?project_ref=abc",
		authentication: "headers" as const,
		headers: { Authorization: "Bearer a", "X-Extra": "b" },
	};
	it("binds URL, authentication, transport and headers, not display hints", async () => {
		const connectors = service([
			{ slug: "tracker", endpoint: "https://mcp.example.test/mcp" },
		]);
		const fingerprint = async (patch: object) =>
			(await connectors.prepare(actor, { ...base, ...patch })).request
				.fingerprint;
		const original = await fingerprint({});
		expect(await fingerprint({ suggestionId: "tracker", label: "Other" })).toBe(
			original,
		);
		// Header order does not matter; header values do.
		expect(
			await fingerprint({
				headers: { "X-Extra": "b", Authorization: "Bearer a" },
			}),
		).toBe(original);
		for (const patch of [
			{ url: "https://mcp.example.test/mcp?project_ref=abd" },
			{ authentication: "oauth" },
			{ transport: "http" },
			{ headers: { Authorization: "Bearer other", "X-Extra": "b" } },
		])
			expect(await fingerprint(patch), JSON.stringify(patch)).not.toBe(
				original,
			);
	});
	it("keeps a suggestion only while the URL display-matches it, and never fails on the catalog", async () => {
		const connectors = service([
			{ slug: "tracker", endpoint: "https://mcp.example.test/mcp" },
			{ slug: "notes", endpoint: "https://notes.example.test/mcp" },
		]);
		const hint = async (suggestionId: string, url = base.url) =>
			(await connectors.prepare(actor, { ...base, url, suggestionId })).request
				.suggestionId;
		expect(await hint("tracker")).toBe("tracker");
		expect(await hint("notes")).toBeNull();
		expect(await hint("tracker", "https://elsewhere.test/mcp")).toBeNull();
		const unavailable = createConnectorService({
			source: {
				read: async () => {
					throw new Error("offline");
				},
			},
			key: "k",
			authorize: async () => {},
			preview: async () => {
				throw new Error("unused");
			},
			create: async (_actor, input, request) => ({
				id: "created",
				label: input.label ?? "x",
				url: input.url,
				transport: "http",
				authentication: input.authentication,
				status: request.suggestionId ?? "no hint",
			}),
		});
		expect(
			(await unavailable.connect(actor, { ...base, suggestionId: "tracker" }))
				.status,
		).toBe("no hint");
	});
});

describe("operator OAuth clients", () => {
	const configured = JSON.stringify([
		{
			origin: "https://mcp.example.test",
			env: "EXAMPLE_MCP",
			issuer: "https://login.example.test/oauth",
		},
	]);
	it("reads the client from the configured environment names for its exact origin", () => {
		const environment = {
			UPSTREAM_OAUTH_CLIENTS: configured,
			EXAMPLE_MCP_CLIENT_ID: "synthetic-client",
			EXAMPLE_MCP_CLIENT_SECRET: "synthetic-secret",
		};
		expect(
			registeredClientFor("https://mcp.example.test", environment),
		).toEqual({
			required: true,
			client: {
				clientId: "synthetic-client",
				clientSecret: "synthetic-secret",
				issuer: "https://login.example.test/oauth",
			},
		});
		for (const origin of [
			"https://mcp.example.test.attacker.test",
			"https://example.test",
			"http://mcp.example.test",
			"https://mcp.example.test:8443",
		])
			expect(registeredClientFor(origin, environment), origin).toBeUndefined();
	});
	it("defaults to today's GitHub mapping and marks a client required until both values are set", () => {
		expect(upstreamOAuthClients(undefined)).toEqual([
			{
				origin: "https://api.githubcopilot.com",
				env: "GITHUB_MCP",
				issuer: "https://github.com/login/oauth",
			},
		]);
		expect(
			registeredClientFor("https://api.githubcopilot.com", {
				GITHUB_MCP_CLIENT_ID: "synthetic-client",
			}),
		).toEqual({ required: true });
		expect(
			registeredClientFor("https://api.githubcopilot.com", {
				UPSTREAM_OAUTH_CLIENTS: configured,
			}),
		).toBeUndefined();
	});
	it("rejects invalid configuration instead of ignoring it", () => {
		for (const value of [
			"not json",
			"{}",
			JSON.stringify([{ origin: "https://mcp.example.test/", env: "X" }]),
			JSON.stringify([{ origin: "http://mcp.example.test", env: "X" }]),
			JSON.stringify([{ origin: "https://mcp.example.test", env: "lower" }]),
			JSON.stringify([
				{ origin: "https://mcp.example.test", env: "A" },
				{ origin: "https://mcp.example.test", env: "B" },
			]),
			JSON.stringify([
				{ origin: "https://mcp.example.test", env: "A", extra: true },
			]),
		])
			expect(() => upstreamOAuthClients(value), value).toThrow(
				"UPSTREAM_OAUTH_CLIENTS",
			);
	});
});
