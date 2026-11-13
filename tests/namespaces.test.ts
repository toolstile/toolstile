import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	Server,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { afterAll, describe, expect, it } from "vitest";
import {
	allocateNamespaces,
	migrateDatabaseWithLock,
	namespaceBase,
	nextNamespace,
	openDatabase,
} from "../packages/database/src/index";
import {
	alias,
	emptyRules,
	exposedName,
	handleMcp,
	type Runtime,
	type Upstream,
} from "../packages/gateway/src/index";

describe("namespace names", () => {
	it("derives a short readable base from a label", () => {
		expect(namespaceBase("Linear")).toBe("linear");
		expect(namespaceBase("Google Drive (work)")).toBe("google_drive_work");
		expect(namespaceBase("Café__Menu")).toBe("cafe_menu");
		expect(namespaceBase("42 Things")).toBe("things");
		expect(namespaceBase("日本")).toBe("server");
		expect(namespaceBase("a".repeat(40))).toHaveLength(20);
		expect(namespaceBase("abcdefghijklmnopqrs tail")).toBe(
			"abcdefghijklmnopqrs",
		);
	});
	it("numbers duplicates from 2 without running digits together", () => {
		expect(nextNamespace("Linear", new Set())).toBe("linear");
		expect(nextNamespace("Linear", new Set(["linear"]))).toBe("linear2");
		expect(nextNamespace("linear", new Set(["linear", "linear2"]))).toBe(
			"linear3",
		);
		expect(nextNamespace("S3", new Set(["s3"]))).toBe("s3_2");
	});
});

const cleanup: (() => unknown)[] = [];
afterAll(async () => {
	for (const step of cleanup.reverse()) await step();
});

describe("namespace allocation", { timeout: 30_000 }, () => {
	async function open() {
		const directory = mkdtempSync(join(tmpdir(), "toolstile-namespaces-"));
		cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
		const { pool } = openDatabase(join(directory, "pglite"));
		cleanup.push(() => pool.end());
		await migrateDatabaseWithLock(pool, {
			migrationsFolder: resolve(
				import.meta.dirname,
				"../apps/web/postgres-migrations",
			),
		});
		return pool;
	}

	it("keeps names stable, scoped and never reassigned", async () => {
		const pool = await open();
		const first = await allocateNamespaces(pool, "owner", [
			{ id: "one", label: "Linear" },
			{ id: "two", label: "Linear" },
		]);
		expect([...first]).toEqual([
			["one", "linear"],
			["two", "linear2"],
		]);
		// Another scope has its own names; a label change keeps the allocated one.
		expect(
			(
				await allocateNamespaces(pool, "other", [{ id: "x", label: "Linear" }])
			).get("x"),
		).toBe("linear");
		expect(
			(
				await allocateNamespaces(pool, "owner", [{ id: "two", label: "Jira" }])
			).get("two"),
		).toBe("linear2");
		// "one" is gone, but its name stays retired.
		const later = await allocateNamespaces(pool, "owner", [
			{ id: "two", label: "Linear" },
			{ id: "three", label: "Linear" },
		]);
		expect(later.get("three")).toBe("linear3");
	});

	it("resolves concurrent allocations to distinct names", async () => {
		const pool = await open();
		const results = await Promise.all(
			["a", "b", "c", "d"].map((id) =>
				allocateNamespaces(pool, "owner", [{ id, label: "Linear" }]),
			),
		);
		const names = results.map((result, i) => result.get("abcd"[i]));
		expect(new Set(names).size).toBe(4);
		expect(names.every((name) => /^linear\d*$/.test(name ?? ""))).toBe(true);
	});
});

describe("readable gateway names", () => {
	function fixture(account: string): typeof fetch {
		return async (input, init) => {
			const server = new Server(
				{ name: "fixture", version: "1" },
				{ capabilities: { tools: {}, prompts: {} } },
			);
			server.setRequestHandler("tools/list", async () => ({
				tools: [
					{
						name: "get_issue",
						description: "Get an issue",
						inputSchema: {
							type: "object",
							properties: { id: { type: "string" } },
						},
					},
					{ name: "delete_issue", inputSchema: { type: "object" } },
				],
			}));
			server.setRequestHandler("tools/call", async (req) => ({
				content: [{ type: "text", text: `${account}:${req.params.name}` }],
			}));
			server.setRequestHandler("prompts/list", async () => ({
				prompts: [{ name: "triage" }],
			}));
			server.setRequestHandler("prompts/get", async () => ({
				messages: [{ role: "user", content: { type: "text", text: account } }],
			}));
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await server.connect(transport);
			try {
				return await transport.handleRequest(
					new Request(
						input instanceof Request ? input.url : String(input),
						init,
					),
				);
			} finally {
				await server.close();
			}
		};
	}

	it("lists and routes namespace__tool names, and still accepts legacy names", async () => {
		const rules = emptyRules();
		rules.full = true;
		rules.block.tools = ["delete_issue"];
		rules.block.prompts = [];
		const upstream = (id: string, namespace: string): Upstream => ({
			id,
			namespace,
			label: "Linear",
			url: `http://${id}/mcp`,
			transport: "http",
			headers: {},
			rules: [rules],
		});
		const sources = [upstream("work", "linear"), upstream("home", "linear2")];
		const runtime: Runtime = {
			connections: async () => sources,
			admit: async () => {},
			record: async () => {},
			validateDestination: async () => {},
			fetch: async (input, init) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				);
				return fixture(url.hostname)(input, init);
			},
		};
		const client = new Client({ name: "test-agent", version: "1" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://gateway/mcp"), {
				fetch: async (input, init) =>
					handleMcp(
						new Request(
							input instanceof Request ? input.url : String(input),
							init,
						),
						runtime,
					),
			}),
		);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((tool) => tool.name)).toEqual([
				"linear__get_issue",
				"linear2__get_issue",
			]);
			// Upstream descriptions and schemas pass through unchanged.
			expect(tools[0]).toMatchObject({
				description: "Get an issue",
				inputSchema: { properties: { id: { type: "string" } } },
			});
			for (const [name, text] of [
				["linear__get_issue", "work:get_issue"],
				["linear2__get_issue", "home:get_issue"],
				[alias("home", "get_issue"), "home:get_issue"],
			])
				expect(
					(await client.callTool({ name, arguments: {} })).content,
				).toEqual([{ type: "text", text }]);
			for (const name of [
				"linear__delete_issue",
				alias("work", "delete_issue"),
				"linear3__get_issue",
				"linear__",
			])
				await expect(
					client.callTool({ name, arguments: {} }),
				).rejects.toThrow();
			expect(
				(await client.listPrompts()).prompts.map((prompt) => prompt.name),
			).toEqual(["linear__triage", "linear2__triage"]);
			expect(
				(await client.getPrompt({ name: "linear2__triage" })).messages[0]
					.content,
			).toEqual({ type: "text", text: "home" });
		} finally {
			await client.close();
		}
	});

	it("falls back to the legacy alias without a namespace", () => {
		expect(exposedName({ id: "a" }, "read")).toBe(alias("a", "read"));
		expect(exposedName({ id: "a", namespace: "linear" }, "read")).toBe(
			"linear__read",
		);
	});

	it("keeps the fixed-length legacy alias when a readable name exceeds 128 characters", () => {
		const fits = "t".repeat(120);
		const long = "t".repeat(121);
		const upstream = { id: "a", namespace: "linear" };
		expect(exposedName(upstream, fits)).toBe(`linear__${fits}`);
		expect(exposedName(upstream, fits)).toHaveLength(128);
		expect(exposedName(upstream, long)).toBe(alias("a", long));
	});
});
