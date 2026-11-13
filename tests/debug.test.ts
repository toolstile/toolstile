import {
	Server,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { boundedDebugPayload } from "../packages/gateway/src/debug";
import {
	emptyRules,
	invoke,
	type Operation,
	type Runtime,
} from "../packages/gateway/src/index";

it("bounds and redacts debug content before encryption", () => {
	const value = boundedDebugPayload({
		arguments: {
			authorization: "Bearer auth",
			headers: { custom: "credential" },
			client_secret: "oauth secret",
			nested: { apiKey: "api secret" },
			text: "Bearer bearer-value access_token=token-value",
			huge: "é".repeat(100000),
		},
		result: { refresh_token: "refresh", cookie: "session", ok: true },
	});
	const json = JSON.stringify(value);
	for (const secret of [
		"oauth secret",
		"credential",
		"api secret",
		"bearer-value",
		"token-value",
		'refresh"',
		'"session"',
	])
		expect(json).not.toContain(secret);
	expect(value.truncated).toBe(true);
	expect(Buffer.byteLength(json)).toBeLessThanOrEqual(65536);
});

it("optional gateway capture receives only selected request data and uses the admitted operation identity", async () => {
	const rules = emptyRules();
	rules.full = true;
	const source = {
		id: "one",
		label: "Fixture",
		url: "http://fixture/mcp",
		transport: "http",
		headers: { Authorization: "Bearer transport-secret" },
		rules: [rules],
	};
	const admitted: Operation[] = [],
		captured: { operation: Operation; payload: unknown }[] = [];
	const runtime: Runtime = {
		sessionKey: "capture:fixture",
		connections: async () => [source],
		admit: async (operation) => {
			admitted.push(operation);
		},
		record: async () => {},
		validateDestination: async () => {},
		fetch: async (input, init) => {
			const server = new Server(
				{ name: "capture-fixture", version: "1" },
				{ capabilities: { tools: {} } },
			);
			server.setRequestHandler("tools/call", async () => ({
				content: [{ type: "text", text: "fixture result" }],
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
		},
	};
	await invoke(
		runtime,
		source,
		"tools/call",
		"read",
		(client) => client.callTool({ name: "read", arguments: { text: "off" } }),
		"tools",
	);
	expect(captured).toEqual([]);
	runtime.capture = async (operation) => async (payload) => {
		captured.push({ operation, payload });
	};
	await invoke(
		runtime,
		source,
		"tools/call",
		"read",
		(client) =>
			client.callTool({ name: "read", arguments: { text: "selected" } }),
		"tools",
	);
	expect(captured).toHaveLength(1);
	expect(captured[0].operation.id).toBe(admitted.at(-1)?.id);
	expect(captured[0].payload).toMatchObject({
		arguments: { text: "selected" },
		result: { content: [{ text: "fixture result" }] },
	});
	expect(JSON.stringify(captured)).not.toContain("transport-secret");
	expect(JSON.stringify(captured)).not.toContain("headers");
});

it.each(["none", "tool", "rpc"])(
	"meters distinct modern follow-up requests separately with decoded %s outcome",
	async (failure) => {
		const { Client, StreamableHTTPClientTransport } = await import(
			"@modelcontextprotocol/client"
		);
		const { createMcpHandler, inputRequired } = await import(
			"@modelcontextprotocol/server"
		);
		const { createMcpGateway, alias } = await import(
			"../packages/gateway/src/index"
		);
		const handler = createMcpHandler(
			() => {
				const server = new Server(
					{ name: "modern-capture", version: "1" },
					{ capabilities: { tools: {} } },
				);
				server.setRequestHandler("tools/list", async () => ({
					tools: [{ name: "read", inputSchema: { type: "object" } }],
				}));
				server.setRequestHandler("tools/call", async (_req, context) => {
					if (!context.mcpReq.requestState())
						return inputRequired({
							inputRequests: { roots: inputRequired.listRoots() },
							requestState: "roots",
						});
					if (failure === "rpc") throw new Error("modern domain failure");
					return {
						content: [{ type: "text", text: "modern final result" }],
						isError: failure === "tool",
					};
				});
				return server;
			},
			{ legacy: "reject" },
		);
		const rules = emptyRules();
		rules.full = true;
		const source = {
			id: "modern",
			label: "Modern fixture",
			url: "https://fixture/mcp",
			transport: "http",
			headers: {},
			rules: [rules],
		};
		const admitted: Operation[] = [],
			captured: unknown[] = [],
			recorded: { operation: Operation; outcome: string }[] = [];
		const runtime: Runtime = {
			sessionKey: "capture:modern",
			connections: async () => [source],
			admit: async (operation) => {
				admitted.push(operation);
			},
			record: async (operation, outcome) => {
				recorded.push({ operation, outcome });
			},
			validateDestination: async () => {},
			fetch: (input, init) => handler.fetch(new Request(input, init)),
			capture: async () => async (payload) => {
				captured.push(payload);
			},
		};
		const gateway = createMcpGateway();
		const client = new Client(
			{ name: "modern-agent", version: "1" },
			{
				capabilities: { roots: {} },
				versionNegotiation: { mode: { pin: "2026-07-28" } },
			},
		);
		client.setRequestHandler("roots/list", async () => ({ roots: [] }));
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL("https://gateway/mcp"), {
					fetch: (input, init) =>
						gateway.handle(new Request(input, init), runtime),
				}),
			);
			const work = client.callTool({
				name: alias(source.id, "read"),
				arguments: { text: "one logical call" },
			});
			if (failure === "rpc")
				await expect(work).rejects.toThrow("modern domain failure");
			else expect(JSON.stringify(await work)).toContain("modern final result");
			const toolRequests = admitted.filter(
				(operation) => operation.method === "tools/call",
			);
			expect(toolRequests).toHaveLength(2);
			expect(new Set(toolRequests.map((operation) => operation.id)).size).toBe(
				2,
			);
			expect(captured).toHaveLength(failure === "rpc" ? 0 : 1);
			const toolRecords = recorded.filter(
				({ operation }) => operation.method === "tools/call",
			);
			expect(toolRecords).toHaveLength(2);
			for (const [index, operation] of toolRequests.entries())
				expect(
					toolRecords.find((record) => record.operation.id === operation.id)
						?.outcome,
				).toBe(
					index === 0 && failure !== "none" ? "upstream_error" : "forwarded",
				);
		} finally {
			await client.close();
			await gateway.close();
		}
	},
);
