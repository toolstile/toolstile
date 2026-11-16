import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { connectionInput } from "../packages/api/src/contract";
import {
	connectionLabel,
	detectConnection,
	detectServerAddress,
} from "../packages/gateway/src/index";
import { startFixture } from "./fixture";
import { startOAuthHttpFixture } from "./oauth-http-fixture";
import { serveFixture } from "./session-fixture";

describe("connection detection", () => {
	let plain: Awaited<ReturnType<typeof startFixture>>;
	let oauth: Awaited<ReturnType<typeof startOAuthHttpFixture>>;
	beforeAll(async () => {
		plain = await startFixture();
		oauth = await startOAuthHttpFixture();
	});
	afterAll(async () => {
		await plain.close();
		await oauth.close();
	});
	// Failed probes are expected here. Their warnings carry only a bare reason,
	// never the address or headers, which may hold credentials.
	let warn: MockInstance<typeof console.warn>;
	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		try {
			for (const call of warn.mock.calls)
				expect(call).toEqual([
					"MCP connection probe failed",
					expect.stringMatching(/^[A-Za-z][\w ]*$/),
				]);
		} finally {
			warn.mockRestore();
		}
	});
	it("accepts URL-only input and defaults both settings to auto", () => {
		expect(
			connectionInput.parse({ url: "https://mcp.example.com/mcp" }),
		).toEqual({
			url: "https://mcp.example.com/mcp",
			transport: "auto",
			authentication: "auto",
			headers: {},
		});
	});
	it("initializes a plain HTTP MCP without invoking agent tools", async () => {
		expect(await detectConnection({ url: plain.url, fetch })).toEqual({
			transport: "http",
			authentication: "headers",
			status: "reachable",
		});
		expect(plain.calls()).toBe(0);
	});
	it("recognizes OAuth without making authorization or token requests", async () => {
		expect(await detectConnection({ url: oauth.url, fetch })).toEqual({
			transport: "http",
			authentication: "oauth",
			status: "authentication required",
		});
		expect(oauth.exchanges()).toBe(0);
	});
	it("keeps supplied Authorization credentials in header mode after a 401", async () => {
		expect(
			await detectConnection({
				url: oauth.url,
				fetch,
				headers: { aUtHoRiZaTiOn: "Bearer wrong" },
			}),
		).toEqual({
			transport: "http",
			authentication: "headers",
			status: "needs attention",
		});
	});
	it("falls back to legacy SSE, forwards headers, and closes its stream", async () => {
		let events: ReadableStreamDefaultController<Uint8Array> | undefined;
		let closed = false;
		const encoder = new TextEncoder();
		const fixture = await serveFixture(async (input, init) => {
			const request = new Request(input, init);
			expect(request.headers.get("x-fixture")).toBe("probe");
			if (request.method === "GET") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							events = controller;
							controller.enqueue(
								encoder.encode("event: endpoint\ndata: /messages\n\n"),
							);
						},
						cancel() {
							closed = true;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (new URL(request.url).pathname !== "/messages")
				return new Response(null, { status: 405 });
			const body = await request.json();
			if (body.method === "initialize")
				events?.enqueue(
					encoder.encode(
						`event: message\ndata: ${JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: body.params.protocolVersion,
								capabilities: {},
								serverInfo: { name: "legacy-fixture", version: "1" },
							},
						})}\n\n`,
					),
				);
			return new Response(null, { status: 202 });
		});
		try {
			expect(
				await detectConnection({
					url: fixture.url,
					fetch,
					headers: { "x-fixture": "probe" },
				}),
			).toEqual({
				transport: "sse",
				authentication: "headers",
				status: "reachable",
			});
			await vi.waitFor(() => expect(closed).toBe(true));
		} finally {
			await fixture.close();
		}
	});
	it("recognizes legacy SSE 401 after an HTTP failure", async () => {
		const send = vi.fn<typeof fetch>(
			async (input, init) =>
				new Response(null, {
					status: new Request(input, init).method === "GET" ? 401 : 405,
				}),
		);
		expect(await detectConnection({ url: plain.url, fetch: send })).toEqual({
			transport: "sse",
			authentication: "oauth",
			status: "authentication required",
		});
	});
	it("saves unreachable destinations as needing attention", async () => {
		const send = vi.fn<typeof fetch>(async () => {
			throw new TypeError("unreachable");
		});
		expect(await detectConnection({ url: plain.url, fetch: send })).toEqual({
			transport: "http",
			authentication: "headers",
			status: "needs attention",
		});
	});
	it("bounds hanging probes and aborts their requests", async () => {
		const signals: AbortSignal[] = [];
		const send: typeof fetch = async (_, init) => {
			if (init?.signal) signals.push(init.signal);
			return new Promise(() => {});
		};
		const started = Date.now();
		expect(
			(await detectConnection({ url: plain.url, fetch: send, timeoutMs: 80 }))
				.status,
		).toBe("needs attention");
		expect(Date.now() - started).toBeLessThan(500);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});
	it.each(["headers", "oauth"] as const)(
		"preserves fully explicit %s settings without network traffic",
		async (authentication) => {
			const send = vi.fn<typeof fetch>();
			expect(
				await detectConnection({
					url: plain.url,
					fetch: send,
					transport: "sse",
					authentication,
				}),
			).toEqual({
				transport: "sse",
				authentication,
				status:
					authentication === "oauth" ? "authentication required" : "configured",
			});
			expect(send).not.toHaveBeenCalled();
		},
	);
	it("only probes the explicitly selected transport", async () => {
		const send = vi.fn<typeof fetch>(
			async () => new Response(null, { status: 405 }),
		);
		expect(
			await detectConnection({ url: plain.url, fetch: send, transport: "sse" }),
		).toEqual({
			transport: "sse",
			authentication: "headers",
			status: "needs attention",
		});
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("preserves explicit authentication while detecting transport", async () => {
		expect(
			await detectConnection({
				url: oauth.url,
				fetch,
				authentication: "headers",
			}),
		).toEqual({
			transport: "http",
			authentication: "headers",
			status: "needs attention",
		});
	});
	it.each([
		["https://www.example.com/mcp", "example.com"],
		["https://mcp.example.com/mcp", "example.com"],
		["http://127.0.0.1:4312/mcp?secret=hidden", "127.0.0.1:4312/mcp"],
		["http://localhost:4312/mcp", "localhost:4312/mcp"],
		["http://[::1]:4312/mcp", "[::1]:4312/mcp"],
	])("derives a label from %s", (url, label) => {
		expect(connectionLabel(url)).toBe(label);
	});
	it("tries /mcp on the same host when an address without a path does not answer", async () => {
		const origin = new URL(plain.url).origin;
		const paths: string[] = [];
		// Only /mcp is an MCP server; the host's root answers 404, as a website would.
		const send = vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			paths.push(url.pathname);
			expect(url.origin).toBe(origin);
			return url.pathname === "/mcp"
				? fetch(request)
				: new Response("Not found", { status: 404 });
		});
		expect(await detectServerAddress({ url: origin, fetch: send })).toEqual({
			url: `${origin}/mcp`,
			transport: "http",
			authentication: "headers",
			status: "reachable",
		});
		expect(paths[0]).toBe("/");
		expect(paths).toContain("/mcp");
		expect(paths).not.toContain("/sse");
	});
	it("tries /sse after /mcp and keeps the given address when neither answers", async () => {
		const tried: string[] = [];
		const send = vi.fn<typeof fetch>(async (input, init) => {
			tried.push(new URL(new Request(input, init).url).pathname);
			return new Response("Not found", { status: 404 });
		});
		expect(
			await detectServerAddress({
				url: "https://mcp.example.test/",
				fetch: send,
			}),
		).toEqual({
			url: "https://mcp.example.test/",
			transport: "http",
			authentication: "headers",
			status: "needs attention",
		});
		expect([...new Set(tried)]).toEqual(["/", "/mcp", "/sse"]);
	});
	it("does not try other paths for an address with a path, query or sign-in", async () => {
		const send = vi.fn<typeof fetch>(
			async () => new Response("Not found", { status: 404 }),
		);
		for (const url of [
			"https://mcp.example.test/v1",
			"https://mcp.example.test/?key=1",
		]) {
			send.mockClear();
			expect((await detectServerAddress({ url, fetch: send })).url).toBe(url);
			expect(
				send.mock.calls.every(([input, init]) =>
					new Request(input, init).url.startsWith(url),
				),
			).toBe(true);
		}
		// A root that asks for sign-in is an MCP server already.
		send.mockImplementation(async () => new Response(null, { status: 401 }));
		send.mockClear();
		expect(
			await detectServerAddress({
				url: "https://mcp.example.test",
				fetch: send,
			}),
		).toMatchObject({
			url: "https://mcp.example.test",
			status: "authentication required",
		});
		expect(
			send.mock.calls.every(
				([input, init]) =>
					new URL(new Request(input, init).url).pathname === "/",
			),
		).toBe(true);
	});
	it("caps derived labels at 100 characters", () => {
		expect(
			connectionLabel(`https://${"a".repeat(60)}.${"b".repeat(60)}.com/mcp`),
		).toHaveLength(100);
	});
});
