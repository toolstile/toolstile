import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	Server,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import {
	alias,
	emptyRules,
	handleMcp,
	type Operation,
	type Runtime,
} from "../packages/gateway/src/index";

it("forwards permitted tools/resources/prompts and rejects cached blocked names", async () => {
	const rules = emptyRules();
	rules.full = true;
	rules.block.tools = ["delete"];
	const operations: Operation[] = [];
	let calls = 0,
		reservations = 0;
	const fixture: typeof fetch = async (input, init) => {
		const server = new Server(
			{ name: "fixture", version: "1" },
			{ capabilities: { tools: {}, resources: {}, prompts: {} } },
		);
		server.setRequestHandler("tools/list", async () => ({
			tools: [
				{ name: "read", inputSchema: { type: "object" } },
				{ name: "delete", inputSchema: { type: "object" } },
			],
		}));
		server.setRequestHandler("tools/call", async (req) => {
			calls++;
			return { content: [{ type: "text", text: req.params.name }] };
		});
		server.setRequestHandler("resources/list", async () => ({
			resources: [{ uri: "test://doc", name: "Document" }],
		}));
		server.setRequestHandler("resources/read", async () => ({
			contents: [{ uri: "test://doc", text: "hello" }],
		}));
		server.setRequestHandler("prompts/list", async () => ({
			prompts: [{ name: "review" }],
		}));
		server.setRequestHandler("prompts/get", async () => ({
			messages: [{ role: "user", content: { type: "text", text: "review" } }],
		}));
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
	const runtime: Runtime = {
		connections: async () => [
			{
				id: "a",
				label: "Fixture",
				url: "http://fixture/mcp",
				transport: "http",
				headers: {},
				rules: [rules],
			},
		],
		admit: async (operation) => {
			operations.push(operation);
			reservations++;
		},
		record: async () => {},
		validateDestination: async () => {},
		fetch: fixture,
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
		const catalog = await client.listTools();
		expect(catalog.tools.map((t) => t.name)).toEqual([alias("a", "read")]);
		const result = await client.callTool({
			name: alias("a", "read"),
			arguments: {},
		});
		expect(result.content).toEqual([{ type: "text", text: "read" }]);
		await expect(
			client.callTool({ name: alias("a", "delete"), arguments: {} }),
		).rejects.toThrow();
		expect(calls).toBe(1);
		const resources = await client.listResources();
		const resource = await client.readResource({
			uri: resources.resources[0].uri,
		});
		expect(resource.contents[0]).toMatchObject({ text: "hello" });
		const prompts = await client.listPrompts();
		const prompt = await client.getPrompt({ name: prompts.prompts[0].name });
		expect(prompt.messages).toHaveLength(1);
		expect(reservations).toBeGreaterThanOrEqual(8);
		expect(
			operations.filter((op) => !op.maintenance).map((op) => op.method),
		).toEqual([
			"tools/list",
			"tools/list",
			"tools/call",
			"resources/list",
			"resources/read",
			"prompts/list",
			"prompts/list",
			"prompts/get",
		]);
	} finally {
		await client.close();
	}
});
