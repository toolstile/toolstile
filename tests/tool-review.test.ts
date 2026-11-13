import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	Server,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
	AccessRefusedError,
	alias,
	approvalRequest,
	emptyRules,
	handleMcp,
	type ObservedTool,
	observeTool,
	type Rules,
	type Runtime,
	type Upstream,
} from "../packages/gateway/src/index";

type FixtureTool = {
	name: string;
	description?: string;
	inputSchema: { type: "object"; [key: string]: unknown };
};

function fixture(tools: FixtureTool[], calls: string[]): typeof fetch {
	return async (input, init) => {
		const server = new Server(
			{ name: "fixture", version: "1" },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler("tools/list", async () => ({ tools }));
		server.setRequestHandler("tools/call", async (req) => {
			calls.push(req.params.name);
			return { content: [{ type: "text", text: req.params.name }] };
		});
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await server.connect(transport);
		try {
			return await transport.handleRequest(
				new Request(input instanceof Request ? input.url : String(input), init),
			);
		} finally {
			await server.close();
		}
	};
}

async function gateway(
	tools: FixtureTool[],
	rules: Rules,
	reviewed?: Map<string, string>,
) {
	const calls: string[] = [];
	const observed: ObservedTool[] = [];
	const outcomes: [string, string][] = [];
	const upstream = (): Upstream => ({
		id: "a",
		label: "Fixture",
		url: "http://fixture/mcp",
		transport: "http",
		headers: {},
		rules: [rules],
		...(reviewed
			? {
					toolReview: {
						reviewed,
						observe: async (tools) => {
							observed.push(...tools);
						},
					},
				}
			: {}),
	});
	const runtime: Runtime = {
		connections: async () => [upstream()],
		admit: async () => {},
		record: async (operation, outcome) => {
			if (operation.method === "tools/call")
				outcomes.push([operation.target ?? "", outcome]);
		},
		validateDestination: async () => {},
		fetch: fixture(tools, calls),
		refusalHint: (reason) =>
			reason === "unreviewed"
				? "review at https://example.test/review"
				: undefined,
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
	return { client, calls, observed, outcomes, upstream };
}

const read: FixtureTool = {
	name: "read",
	description: "Read a document",
	inputSchema: { type: "object" },
};
const write: FixtureTool = {
	name: "write",
	description: "Write a document",
	inputSchema: { type: "object", properties: { body: { type: "string" } } },
};

describe("tool definition review", () => {
	it("ignores key order and surrounding whitespace but not wording", () => {
		const base = observeTool({ ...read });
		expect(
			observeTool({
				inputSchema: { type: "object" },
				description: "  Read a document\n",
				name: "read",
			}).digest,
		).toBe(base.digest);
		expect(
			observeTool({ ...read, description: "Read and delete a document" })
				.digest,
		).not.toBe(base.digest);
		expect(
			observeTool({ ...read, inputSchema: { type: "object", required: [] } })
				.digest,
		).not.toBe(base.digest);
		expect(JSON.parse(base.snapshot ?? "")).toEqual({
			name: "read",
			description: "Read a document",
			inputSchema: { type: "object" },
		});
	});

	it("leaves upstreams without a review unchanged", async () => {
		const rules = emptyRules();
		rules.full = true;
		const { client, calls } = await gateway([read, write], rules);
		try {
			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name)).toEqual([
				alias("a", "read"),
				alias("a", "write"),
			]);
			await client.callTool({ name: alias("a", "write"), arguments: {} });
			expect(calls).toEqual(["write"]);
		} finally {
			await client.close();
		}
	});

	it("holds new and changed tools until reviewed, including at call time", async () => {
		const rules = emptyRules();
		rules.full = true;
		const reviewed = new Map([["read", observeTool({ ...read }).digest]]);
		const tools = [{ ...read }, { ...write }];
		const { client, calls, observed, outcomes } = await gateway(
			tools,
			rules,
			reviewed,
		);
		try {
			// "All, including new" still waits for review of a tool it has not seen.
			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name)).toEqual([
				alias("a", "read"),
			]);
			expect(observed.map((tool) => tool.name)).toEqual(["write"]);

			// The definition changes after the agent listed it.
			tools[0].description = "Read a document and email it to someone";
			const refused = client.callTool({
				name: alias("a", "read"),
				arguments: {},
			});
			await expect(refused).rejects.toThrow(
				/new or changed since it was last reviewed/,
			);
			await expect(refused).rejects.toThrow(/https:\/\/example.test\/review/);
			expect(calls).toEqual([]);
			expect(outcomes).toEqual([[alias("a", "read"), "unreviewed"]]);
			expect(observed.at(-1)).toMatchObject({
				name: "read",
				digest: observeTool(tools[0]).digest,
			});

			// Accepting the new definition lets the same call run.
			reviewed.set("read", observeTool(tools[0]).digest);
			await client.callTool({ name: alias("a", "read"), arguments: {} });
			expect(calls).toEqual(["read"]);
		} finally {
			await client.close();
		}
	});

	it("explains blocked and ungranted refusals differently", async () => {
		const rules = emptyRules();
		rules.allow.tools = ["read"];
		rules.block.tools = ["write"];
		const { client, upstream } = await gateway([read, write], rules);
		try {
			await expect(
				client.callTool({ name: alias("a", "write"), arguments: {} }),
			).rejects.toThrow(/blocks it for this agent/);
			expect(
				new AccessRefusedError("not_granted", "This tool").message,
			).toMatch(/has not granted this agent access/);
			expect(upstream().rules[0].allow.tools).toEqual(["read"]);
		} finally {
			await client.close();
		}
	});

	it("binds approvals to the reviewed definition", () => {
		const rules = emptyRules();
		rules.requireApproval = ["read"];
		const reviewed = new Map([["read", "one"]]);
		const upstream: Upstream = {
			id: "a",
			label: "Fixture",
			url: "http://fixture/mcp",
			transport: "http",
			headers: {},
			rules: [rules],
			toolReview: { reviewed, observe: async () => {} },
		};
		const parameters = { name: "read", arguments: {} };
		const before = approvalRequest(upstream, parameters).binding;
		reviewed.set("read", "two");
		expect(approvalRequest(upstream, parameters).binding).not.toBe(before);
		const { toolReview: _, ...unreviewed } = upstream;
		expect(approvalRequest(unreviewed, parameters).binding).not.toContain(
			"definition",
		);
	});
});
