import {
	createMcpHandler,
	Server,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
	agentToolCatalog,
	emptyRules,
	type Operation,
	openUpstream,
	type Runtime,
	type Upstream,
	UpstreamUnavailableError,
} from "../packages/gateway/src/index";

import { defined } from "./assertions";

function fixture(modern: boolean, sse: boolean, failure: string) {
	const servers: Server[] = [];
	function server() {
		const instance = new Server(
			{ name: "outcomes", version: "1" },
			{
				capabilities: {
					tools: {},
					resources: {},
					prompts: {},
					completions: {},
				},
			},
		);
		servers.push(instance);
		function result<T>(value: T): T {
			if (failure === "rpc") throw new Error("original upstream failure");
			return value;
		}
		instance.setRequestHandler("tools/list", async () => ({ tools: [] }));
		instance.setRequestHandler("tools/call", async () =>
			result({
				content: [{ type: "text", text: "private result" }],
				isError: failure === "tool",
			}),
		);
		instance.setRequestHandler("resources/read", async () =>
			result({
				contents: [{ uri: "test://one", text: "private result" }],
			}),
		);
		instance.setRequestHandler("prompts/get", async () =>
			result({
				messages: [
					{
						role: "user" as const,
						content: { type: "text" as const, text: "private result" },
					},
				],
			}),
		);
		instance.setRequestHandler("completion/complete", async () =>
			result({
				completion: { values: ["private result"] },
			}),
		);
		return instance;
	}
	const handler = createMcpHandler(server, {
		legacy: "reject",
		responseMode: sse ? "sse" : "auto",
	});
	const source: Upstream = {
		id: "outcomes",
		label: "Fixture",
		url: "https://fixture/mcp",
		transport: "http",
		headers: {},
		rules: [{ ...emptyRules(), full: true }],
	};
	const admitted: Operation[] = [];
	const recorded: { operation: Operation; outcome: string }[] = [];
	const runtime: Runtime = {
		connections: async () => [source],
		validateDestination: async () => {},
		admit: async (operation) => {
			admitted.push(operation);
		},
		record: async (operation, outcome) => {
			recorded.push({ operation, outcome });
		},
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const method = JSON.parse(String(init?.body ?? "{}")).method;
			if (failure === "http" && method === "tools/call")
				return new Response("failure", { status: 503 });
			if (modern) return handler.fetch(request);
			if (method === "server/discover")
				return new Response(null, { status: 404 });
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const instance = server();
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: !sse,
			});
			await instance.connect(transport);
			return transport.handleRequest(request);
		},
	};
	return {
		source,
		runtime,
		admitted,
		recorded,
		close: () => Promise.all(servers.map((instance) => instance.close())),
	};
}

for (const modern of [false, true])
	for (const sse of [false, true]) {
		describe(`${modern ? "modern" : "legacy"} ${sse ? "SSE" : "JSON"} decoded outcomes`, () => {
			for (const method of [
				"tools/call",
				"resources/read",
				"prompts/get",
				"completion/complete",
			] as const) {
				for (const failure of [
					"none",
					"rpc",
					...(method === "tools/call" ? ["tool", "http"] : []),
				]) {
					it(`${method}: ${failure}`, async () => {
						const f = fixture(modern, sse, failure);
						const client = await openUpstream(
							f.runtime,
							f.source,
							method,
							"read",
							"tools",
						);
						try {
							const work =
								method === "tools/call"
									? client.callTool({ name: "read" })
									: method === "resources/read"
										? client.readResource({ uri: "test://one" })
										: method === "prompts/get"
											? client.getPrompt({ name: "read" })
											: client.complete({
													ref: { type: "ref/prompt", name: "read" },
													argument: { name: "x", value: "x" },
												});
							if (failure === "rpc" || failure === "http")
								await expect(work).rejects.toThrow();
							else await work;
							expect(f.admitted).toHaveLength(1);
							expect(f.recorded).toEqual([
								{
									operation: f.admitted[0],
									outcome: failure === "none" ? "forwarded" : "upstream_error",
								},
							]);
							expect(JSON.stringify(f.recorded)).not.toContain(
								"private result",
							);
						} finally {
							await client.close();
							await f.close();
						}
					});
				}
			}
		});
	}

for (const modern of [false, true])
	for (const sse of [false, true]) {
		it(`defers first insert through body decoding and 401 retry (${modern}, ${sse})`, async () => {
			const f = fixture(modern, sse, "rpc");
			let attempts = 0;
			const wireIds: unknown[] = [];
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let headers!: () => void;
			const received = new Promise<void>((resolve) => {
				headers = resolve;
			});
			const fetch = defined(f.runtime.fetch);
			f.source.authProvider = {
				token: async () => "synthetic",
				onUnauthorized: async () => {},
			};
			f.runtime.fetch = async (input, init) => {
				const body = JSON.parse(String(init?.body ?? "{}"));
				if (body.method !== "tools/call") return fetch(input, init);
				wireIds.push(body.id);
				if (++attempts === 1) return new Response(null, { status: 401 });
				const response = await fetch(input, init);
				const reader = defined(response.body).getReader();
				return new Response(
					new ReadableStream({
						async pull(controller) {
							headers();
							await gate;
							const chunk = await reader.read();
							if (chunk.done) controller.close();
							else controller.enqueue(chunk.value);
						},
						cancel: (reason) => reader.cancel(reason),
					}),
					{ status: response.status, headers: response.headers },
				);
			};
			const client = await openUpstream(
				f.runtime,
				f.source,
				"tools/call",
				"read",
				"tools",
			);
			try {
				const work = client.callTool({ name: "read" });
				const rejection = expect(work).rejects.toThrow(
					"original upstream failure",
				);
				await received;
				expect(f.recorded).toEqual([]);
				expect(f.admitted).toHaveLength(2);
				expect(f.admitted[0].id).toBe(f.admitted[1].id);
				expect(wireIds[0]).toBe(wireIds[1]);
				release();
				await rejection;
				expect(f.recorded).toEqual([
					{ operation: f.admitted[0], outcome: "upstream_error" },
				]);
			} finally {
				release();
				await client.close();
				await f.close();
			}
		});
	}

it("preserves decoded domain rejection when recording rejects", async () => {
	const f = fixture(true, false, "rpc");
	f.runtime.record = async () => {
		throw new Error("recording failed");
	};
	const client = await openUpstream(
		f.runtime,
		f.source,
		"tools/call",
		"read",
		"tools",
	);
	try {
		await expect(client.callTool({ name: "read" })).rejects.toThrow(
			"original upstream failure",
		);
	} finally {
		await client.close();
		await f.close();
	}
});

for (const modern of [false, true])
	for (const sse of [false, true]) {
		it(`preserves denied retry after 401 authorization revocation (${modern}, ${sse})`, async () => {
			const f = fixture(modern, sse, "none");
			let revoked = false;
			let calls = 0;
			const send = defined(f.runtime.fetch);
			f.source.authProvider = {
				token: async () => "synthetic",
				onUnauthorized: async () => {
					revoked = true;
				},
			};
			f.runtime.admit = async (operation) => {
				f.admitted.push(operation);
				if (revoked) throw new Error("authorization revoked");
			};
			f.runtime.fetch = async (input, init) => {
				if (JSON.parse(String(init?.body ?? "{}")).method === "tools/call") {
					calls++;
					return new Response(null, { status: 401 });
				}
				return send(input, init);
			};
			const client = await openUpstream(
				f.runtime,
				f.source,
				"tools/call",
				"read",
				"tools",
			);
			try {
				await expect(client.callTool({ name: "read" })).rejects.toThrow(
					"authorization revoked",
				);
				expect(calls).toBe(1);
				expect(f.admitted).toHaveLength(2);
				expect(f.admitted[0].id).toBe(f.admitted[1].id);
				expect(f.recorded).toEqual([
					{ operation: f.admitted[1], outcome: "denied" },
				]);
			} finally {
				await client.close();
				await f.close();
			}
		});
	}

it("records an unreachable upstream once, without admitting or metering it", async () => {
	const f = fixture(true, false, "none");
	f.runtime.fetch = async () => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("Connect Timeout Error"), {
				code: "UND_ERR_CONNECT_TIMEOUT",
			}),
		});
	};
	try {
		const error = await agentToolCatalog(f.runtime, f.source).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(UpstreamUnavailableError);
		expect(error).toMatchObject({
			reason: "UND_ERR_CONNECT_TIMEOUT",
			message:
				"Couldn't reach fixture just now. Check that the server is online, then try again.",
		});
		expect(f.admitted).toEqual([]);
		expect(f.recorded).toEqual([
			{
				operation: expect.objectContaining({
					connectionId: "outcomes",
					method: "initialize",
					maintenance: false,
				}),
				outcome: "upstream_error",
			},
		]);
	} finally {
		await f.close();
	}
});
