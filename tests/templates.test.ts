import {
	Client,
	StreamableHTTPClientTransport,
	UriTemplate,
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
	inspect,
	type Operation,
	operationCapability,
	permitted,
	type Runtime,
	resourceAlias,
	resourceTemplateAlias,
} from "../packages/gateway/src/index";
import { defined } from "./assertions";

it("preserves template expansion, filters completion suggestions and enforces live blocks before reads", async () => {
	const rules = emptyRules();
	rules.allow.resources = ["docs://project/{path}{?revision}"];
	rules.allow.prompts = ["review"];
	rules.block.resources = ["docs://project/secret?revision=main"];
	const operations: Operation[] = [],
		reads: string[] = [],
		completions: unknown[] = [];
	const upstream = {
		id: "a",
		label: "Docs",
		url: "https://fixture/mcp",
		transport: "http",
		headers: {},
		rules: [rules],
	};
	const runtime: Runtime = {
		connections: async () => [upstream],
		admit: async (operation) => {
			operations.push(operation);
			const kind = operationCapability(operation);
			if (
				!kind ||
				(operation.target
					? !permitted([rules], kind, operation.target)
					: !rules.full && !rules.allow[kind].length)
			)
				throw new Error("denied");
		},
		record: async () => {},
		validateDestination: async () => {},
		fetch: async (input, init) => {
			const server = new Server(
				{ name: "templates", version: "1" },
				{ capabilities: { resources: {}, prompts: {}, completions: {} } },
			);
			server.setRequestHandler("resources/list", async (request) =>
				request.params?.cursor
					? {
							resources: [
								{
									name: "Second page",
									uri: "docs://project/second?revision=main",
								},
							],
						}
					: {
							resources: [
								{
									name: "First page",
									uri: "docs://project/first?revision=main",
								},
							],
							nextCursor: "second",
						},
			);
			server.setRequestHandler("resources/templates/list", async () => ({
				resourceTemplates: [
					{
						name: "Project document",
						description: "  A document in the project  ",
						uriTemplate: "docs://project/{path}{?revision}",
					},
				],
			}));
			server.setRequestHandler("resources/read", async (req) => {
				reads.push(req.params.uri);
				return { contents: [{ uri: req.params.uri, text: "document" }] };
			});
			server.setRequestHandler("prompts/list", async () => ({
				prompts: [{ name: "review", arguments: [{ name: "language" }] }],
			}));
			server.setRequestHandler("prompts/get", async () => ({
				messages: [
					{
						role: "user",
						content: {
							type: "resource",
							resource: {
								uri: "docs://project/first?revision=main",
								text: "Review",
							},
						},
					},
				],
			}));
			server.setRequestHandler("completion/complete", async (req) => {
				completions.push(req.params);
				return {
					completion: {
						values:
							req.params.ref.type === "ref/prompt"
								? ["typescript"]
								: ["public", "secret"],
						total: 2,
						hasMore: false,
					},
				};
			});
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
	const client = new Client({ name: "agent", version: "1" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://gateway/mcp"), {
			fetch: (input, init) =>
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
		const templates = await client.listResourceTemplates();
		const uriTemplate = defined(templates.resourceTemplates[0]).uriTemplate;
		expect(uriTemplate).toBe(
			resourceTemplateAlias("a", "docs://project/{path}{?revision}"),
		);
		const uri = new UriTemplate(uriTemplate).expand({
			path: "folder/a b",
			revision: "a/b",
		});
		const resource = await client.readResource({ uri });
		expect(reads).toEqual(["docs://project/folder%2Fa%20b?revision=a%2Fb"]);
		expect(defined(resource.contents[0]).uri).toBe(
			resourceAlias("a", defined(reads[0])),
		);
		const suggestions = await client.complete({
			ref: { type: "ref/resource", uri: uriTemplate },
			argument: { name: "path", value: "" },
			context: { arguments: { revision: "main" } },
		});
		expect(suggestions.completion.values).toEqual(["public"]);
		expect(suggestions.completion.total).toBeUndefined();
		expect(completions[0]).toMatchObject({
			ref: { uri: "docs://project/{path}{?revision}" },
			context: { arguments: { revision: "main" } },
		});
		expect(
			(
				await client.complete({
					ref: { type: "ref/prompt", name: alias("a", "review") },
					argument: { name: "language", value: "type" },
				})
			).completion.values,
		).toEqual(["typescript"]);
		expect(
			operations
				.filter((op) => op.method === "completion/complete")
				.map((op) => [op.capability, op.target]),
		).toEqual([
			["resources", "docs://project/{path}{?revision}"],
			["prompts", "review"],
		]);
		const prompt = await client.getPrompt({ name: alias("a", "review") });
		expect(defined(prompt.messages[0]).content).toMatchObject({
			resource: {
				uri: resourceAlias("a", "docs://project/first?revision=main"),
			},
		});
		await expect(
			client.readResource({
				uri: new UriTemplate(uriTemplate).expand({
					path: "secret",
					revision: "main",
				}),
			}),
		).rejects.toThrow();
		expect(reads).toHaveLength(1);
		rules.block.prompts.push("review");
		await expect(
			client.complete({
				ref: { type: "ref/prompt", name: alias("a", "review") },
				argument: { name: "language", value: "" },
			}),
		).rejects.toThrow();
		expect(completions).toHaveLength(2);
		rules.block.resources.push("docs://project/{path}{?revision}");
		expect((await client.listResourceTemplates()).resourceTemplates).toEqual(
			[],
		);
		await expect(client.readResource({ uri })).rejects.toThrow();
		expect(reads).toHaveLength(1);
	} finally {
		await client.close();
	}
	// Dashboard discovery traverses all pages and includes template grant identifiers.
	rules.block.resources = [];
	rules.full = true;
	const catalog = await inspect(
		{ ...runtime, admit: async () => {} },
		upstream,
	);
	expect(catalog.resources).toEqual([
		"docs://project/first?revision=main",
		"docs://project/second?revision=main",
		"docs://project/{path}{?revision}",
	]);
	// Descriptions are trimmed and only listed for entries that provide one.
	expect(catalog.descriptions).toEqual([
		{
			capability: "resources",
			name: "docs://project/{path}{?revision}",
			description: "A document in the project",
		},
	]);
});

it.each([200, 400, 404, 501])(
	"keeps optional resource templates unavailable under HTTP %i without failing discovery",
	async (status) => {
		const { runtime, upstream, calls } = optionalTemplateFixture(status);
		const result = await inspect(runtime, upstream);
		expect(result.tools).toEqual(["search"]);
		expect(result.resources).toEqual(["docs://guide"]);
		expect(result.prompts).toEqual(["review"]);
		expect(calls).toContain("resources/templates/list");
		expect(calls).toContain("prompts/list");
	},
);

it.each([401, 403, 500])(
	"does not hide HTTP %i failures as unsupported resource templates",
	async (status) => {
		const { runtime, upstream, calls } = optionalTemplateFixture(status);
		await expect(inspect(runtime, upstream)).rejects.toThrow();
		expect(calls).not.toContain("prompts/list");
	},
);

it("does not hide an unimplemented required resource listing", async () => {
	const { runtime, upstream } = optionalTemplateFixture(501, "resources/list");
	await expect(inspect(runtime, upstream)).rejects.toThrow();
});

it.each([200, 400, 404, 501])(
	"does not hide a JSON-RPC internal error under HTTP %i",
	async (status) => {
		const { runtime, upstream } = optionalTemplateFixture(
			status,
			"resources/templates/list",
			-32603,
		);
		await expect(inspect(runtime, upstream)).rejects.toThrow();
	},
);

it.each(["Not found", '{"error":{"code":-32601}}', "x".repeat(8193)])(
	"does not treat an unstructured HTTP404 as a missing optional method (%#)",
	async (body) => {
		const { runtime, upstream } = optionalTemplateFixture(404);
		const fetch = runtime.fetch;
		runtime.fetch = async (input, init) => {
			if (
				typeof init?.body === "string" &&
				JSON.parse(init.body).method === "resources/templates/list"
			)
				return new Response(body, { status: 404 });
			if (!fetch) throw new Error("Fixture fetch missing");
			return fetch(input, init);
		};
		await expect(inspect(runtime, upstream)).rejects.toThrow();
	},
);

function optionalTemplateFixture(
	status: number,
	method = "resources/templates/list",
	code = -32601,
) {
	const rules = emptyRules();
	rules.full = true;
	const upstream = {
		id: "optional-templates",
		label: "Catalog fixture",
		url: "https://fixture/mcp",
		transport: "http",
		headers: {},
		rules: [rules],
	};
	const calls: string[] = [];
	const runtime: Runtime = {
		connections: async () => [upstream],
		admit: async () => {},
		record: async () => {},
		validateDestination: async () => {},
		fetch: async (input, init) => {
			const request =
				typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			if (request?.method) calls.push(request.method);
			if (request?.method === method)
				return Response.json(
					{
						jsonrpc: "2.0",
						id: request.id,
						error: { code, message: "Synthetic catalog error" },
					},
					{ status },
				);
			const server = new Server(
				{ name: "catalog-fixture", version: "1" },
				{ capabilities: { tools: {}, resources: {}, prompts: {} } },
			);
			server.setRequestHandler("tools/list", async () => ({
				tools: [{ name: "search", inputSchema: { type: "object" } }],
			}));
			server.setRequestHandler("resources/list", async () => ({
				resources: [{ name: "Guide", uri: "docs://guide" }],
			}));
			server.setRequestHandler("prompts/list", async () => ({
				prompts: [{ name: "review" }],
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
	return { runtime, upstream, calls };
}
