import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { agentTools } from "../packages/api/src/agent-tools";
import { builtInTools } from "../packages/api/src/built-in-tools";
import type { CatalogEntry } from "../packages/api/src/connectors";
import {
	alias,
	emptyRules,
	handleMcp,
	type Operation,
	type Runtime,
	type Upstream,
} from "../packages/gateway/src/index";

const entry = (
	slug: string,
	name: string,
	extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({
	slug,
	featured: false,
	listed: true,
	name,
	publisher: name,
	description: `${name} tools`,
	categories: ["development"],
	keywords: [],
	capabilities: [],
	documentation: `https://${slug}.example/docs`,
	endpoint: `https://${slug}.example/mcp`,
	authMethods: ["oauth"],
	requirements: "",
	fields: [],
	...extra,
});
// The catalog source holds listed entries only.
const catalog = [
	entry("github", "GitHub", {
		keywords: ["pull requests"],
		toolSnapshot: {
			observedAt: "2026-10-30T00:00:00.000Z",
			source: "discovery",
			tools: [{ name: "list_issues", annotations: { readOnlyHint: true } }],
			resources: [],
			prompts: [],
		},
	}),
	entry("notes", "Notes", {
		fields: [
			{
				name: "project_ref",
				label: "Project",
				help: "",
				required: false,
				kind: "identifier",
			},
		],
	}),
];

async function connect(upstreams: Upstream[]) {
	const operations: Operation[] = [];
	const runtime: Runtime = {
		connections: async () => upstreams,
		admit: async (operation) => {
			operations.push(operation);
		},
		record: async () => {},
		validateDestination: async () => {},
		tools: agentTools({
			catalog: async () => catalog,
			connections: async () => upstreams,
		}),
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
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		const [content] = result.content as { type: string; text: string }[];
		return { isError: result.isError === true, text: content.text };
	};
	return { client, call, operations };
}

it("lists read-only built-in tools to an agent without grants, unmetered", async () => {
	const { client, call, operations } = await connect([]);
	try {
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"search_catalog",
			"get_catalog_entry",
			"get_my_access",
		]);
		// The dashboard's browser-safe list names exactly these tools, in order.
		expect(tools.map(({ name, title }) => ({ name, title }))).toEqual(
			builtInTools.map(({ name, title }) => ({ name, title })),
		);
		for (const tool of tools)
			expect(tool.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
			});
		expect(JSON.parse((await call("get_my_access")).text).connections).toEqual(
			[],
		);
		expect(operations).toEqual([]);
	} finally {
		await client.close();
	}
});

it("searches the catalog source and returns suggested URLs and tool snapshots", async () => {
	const { client, call } = await connect([]);
	try {
		const all = JSON.parse((await call("search_catalog")).text);
		expect(all.services.map((s: { id: string }) => s.id)).toEqual([
			"github",
			"notes",
		]);
		expect(all.services[0].suggestedUrl).toBe("https://github.example/mcp");
		const found = JSON.parse(
			(await call("search_catalog", { query: "pull requests" })).text,
		);
		expect(found.services.map((s: { id: string }) => s.id)).toEqual(["github"]);
		expect(
			JSON.parse((await call("get_catalog_entry", { id: "github" })).text),
		).toMatchObject({
			id: "github",
			suggestedUrl: "https://github.example/mcp",
			toolSnapshot: {
				observedAt: "2026-10-30T00:00:00.000Z",
				tools: [{ name: "list_issues", readOnly: true }],
			},
		});
		expect(
			JSON.parse((await call("get_catalog_entry", { id: "notes" })).text)
				.settings,
		).toEqual([
			{ name: "project_ref", label: "Project", help: "", required: false },
		]);
		expect(await call("get_catalog_entry", { id: "hidden" })).toMatchObject({
			isError: true,
		});
		expect(await call("search_catalog", { limit: 500 })).toMatchObject({
			isError: true,
		});
	} finally {
		await client.close();
	}
});

it("shows only this agent's granted, unblocked tools with gateway names", async () => {
	const rules = emptyRules();
	rules.allow.tools = ["read", "delete"];
	rules.block.tools = ["delete"];
	rules.requireApproval = ["write"];
	const full = emptyRules();
	full.full = true;
	const upstream = (id: string, label: string, rules: Upstream["rules"]) => ({
		id,
		label,
		url: `https://${id}.example/mcp`,
		transport: "http",
		headers: { Authorization: "Bearer secret" },
		rules,
	});
	const { client, call } = await connect([
		upstream("a", "Docs", [rules]),
		upstream("b", "Everything", [full]),
		upstream("c", "Nothing", [emptyRules()]),
	]);
	try {
		const { text } = await call("get_my_access");
		expect(text).not.toContain("secret");
		expect(JSON.parse(text).connections).toEqual([
			{
				connection: "Docs",
				allTools: false,
				tools: [
					{
						name: "read",
						gatewayName: alias("a", "read"),
						approvalRequired: false,
					},
					{
						name: "write",
						gatewayName: alias("a", "write"),
						approvalRequired: true,
					},
				],
			},
			{ connection: "Everything", allTools: true, tools: [] },
		]);
	} finally {
		await client.close();
	}
});
