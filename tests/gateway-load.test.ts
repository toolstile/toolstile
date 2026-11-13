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

it("keeps concurrent agent results, blocks and operation identities isolated", async () => {
	const count = 24,
		rounds = 3;
	const ids = new Set<string>();
	let active = 0,
		peak = 0,
		calls = 0;
	const started = performance.now();
	await Promise.all(
		Array.from({ length: count }, async (_, index) => {
			const owner = `synthetic-${index}`;
			const rules = emptyRules();
			rules.full = true;
			rules.block.tools = ["delete"];
			const operations: Operation[] = [];
			const runtime: Runtime = {
				sessionKey: owner,
				connections: async () => [
					{
						id: "fixture",
						label: "Fixture",
						url: "https://fixture.invalid/mcp",
						transport: "http",
						headers: {},
						rules: [rules],
					},
				],
				validateDestination: async () => {},
				admit: async (operation) => {
					expect(ids.has(operation.id)).toBe(false);
					ids.add(operation.id);
					operations.push(operation);
				},
				record: async () => {},
				fetch: async (input, init) => {
					const server = new Server(
						{ name: owner, version: "1" },
						{ capabilities: { tools: {} } },
					);
					server.setRequestHandler("tools/list", async () => ({
						tools: ["read", "delete"].map((name) => ({
							name,
							inputSchema: { type: "object" as const },
						})),
					}));
					server.setRequestHandler("tools/call", async (request) => {
						expect(request.params.name).toBe("read");
						active++;
						peak = Math.max(peak, active);
						calls++;
						await new Promise((resolve) => setTimeout(resolve, 5));
						active--;
						return { content: [{ type: "text" as const, text: owner }] };
					});
					const transport = new WebStandardStreamableHTTPServerTransport({
						sessionIdGenerator: undefined,
						enableJsonResponse: true,
					});
					await server.connect(transport);
					try {
						return await transport.handleRequest(new Request(input, init));
					} finally {
						await server.close();
					}
				},
			};
			const client = new Client({ name: owner, version: "1" });
			await client.connect(
				new StreamableHTTPClientTransport(
					new URL("https://gateway.invalid/mcp"),
					{
						fetch: (input, init) =>
							handleMcp(new Request(input, init), runtime),
					},
				),
			);
			try {
				expect(
					(await client.listTools()).tools.map((tool) => tool.name),
				).toEqual([alias("fixture", "read")]);
				for (let round = 0; round < rounds; round++) {
					const result = await client.callTool({
						name: alias("fixture", "read"),
						arguments: {},
					});
					expect(result.content).toEqual([{ type: "text", text: owner }]);
				}
				const before = operations.length;
				await expect(
					client.callTool({ name: alias("fixture", "delete"), arguments: {} }),
				).rejects.toThrow();
				expect(operations).toHaveLength(before);
				expect(
					operations.filter((operation) => operation.method === "tools/call"),
				).toHaveLength(rounds);
			} finally {
				await client.close();
			}
		}),
	);
	expect(calls).toBe(count * rounds);
	expect(peak).toBeGreaterThan(1);
	expect(active).toBe(0);
	console.info(
		JSON.stringify({
			syntheticAgents: count,
			toolCalls: calls,
			peakUpstreamCalls: peak,
			elapsedMs: Math.round(performance.now() - started),
		}),
	);
}, 30_000);
