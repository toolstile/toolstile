import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMcpGateway,
	handleMcp,
	type Runtime,
} from "../packages/gateway/src/index";
import {
	boundedMcpRequest,
	readJsonBody,
} from "../packages/gateway/src/request-body";

const maximum = 2 * 1024 * 1024;
const runtime: Runtime = {
	sessionKey: "synthetic:body:agent",
	connections: async () => [],
	admit: async () => {},
	record: async () => {},
	validateDestination: async () => {},
};
const request = (body: BodyInit, headers: Record<string, string> = {}) =>
	new Request("https://gateway.test.invalid/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...headers,
		},
		body,
		duplex: "half",
	} as RequestInit);
afterEach(() => vi.useRealTimers());

describe("MCP ingress body boundary", () => {
	it.each<Record<string, string>>([
		{},
		{ "content-length": "1" },
		{ "mcp-protocol-version": "2026-07-28" },
		{ "mcp-session-id": "existing" },
	])(
		"rejects oversized bodies before routing with headers %j",
		async (headers) => {
			const gateway = createMcpGateway();
			try {
				const body = JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { padding: "x".repeat(maximum) },
				});
				expect(
					(await gateway.handle(request(body, headers), runtime)).status,
				).toBe(413);
				expect(gateway.size).toBe(0);
				expect((await handleMcp(request(body, headers), runtime)).status).toBe(
					413,
				);
			} finally {
				await gateway.close();
			}
		},
	);
	it("rejects declared oversize without reading the source", async () => {
		const cancel = vi.fn();
		const source = new ReadableStream<Uint8Array>(
			{ cancel },
			{ highWaterMark: 0 },
		);
		const result = await boundedMcpRequest(
			request(source, { "content-length": String(maximum + 1) }),
		);
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(413);
		expect(cancel).toHaveBeenCalled();
	});
	it("counts streamed bytes with no declared length and cancels on overflow", async () => {
		const cancel = vi.fn();
		let chunks = 0;
		const source = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024));
					chunks++;
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		const result = await boundedMcpRequest(request(source));
		expect((result as Response).status).toBe(413);
		expect(chunks).toBe(3);
		expect(cancel).toHaveBeenCalled();
	});
	it("times out a stalled body even if source cancellation never resolves", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const source = new ReadableStream<Uint8Array>({ cancel });
		const pending = boundedMcpRequest(request(source));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(((await pending) as Response).status).toBe(408);
		expect(cancel).toHaveBeenCalled();
	});
	it("preserves an exact-limit body, headers and cancellation signal", async () => {
		const bytes = "x".repeat(maximum);
		const original = request(bytes, { "mcp-session-id": "synthetic-session" });
		const result = await boundedMcpRequest(original);
		expect(result).toBeInstanceOf(Request);
		expect((result as Request).headers.get("mcp-session-id")).toBe(
			"synthetic-session",
		);
		expect(await (result as Request).text()).toBe(bytes);
	});
	it("accepts an adapter's Fetch-compatible request wrapper", async () => {
		const original = request("{}");
		const wrapped = {
			url: original.url,
			method: original.method,
			headers: original.headers,
			body: original.body,
			signal: original.signal,
		} as Request;
		const result = await boundedMcpRequest(wrapped);
		expect(result).toBeInstanceOf(Request);
		expect(await (result as Request).text()).toBe("{}");
	});
});

function streaming(chunks: Uint8Array[], cancel = () => {}) {
	return new Request("https://fixture.invalid", {
		method: "POST",
		duplex: "half",
		body: new ReadableStream({
			pull(controller) {
				const chunk = chunks.shift();
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
			cancel,
		}),
	} as RequestInit);
}
const encode = (text: string) => new TextEncoder().encode(text);
describe("application JSON body boundary", () => {
	it("accepts exactly the byte limit across split UTF-8 chunks", async () => {
		const bytes = encode('"é"');
		expect(
			await readJsonBody(streaming([bytes.slice(0, 2), bytes.slice(2)]), 4),
		).toBe("é");
	});
	it("counts bytes and cancels a chunked body without content-length", async () => {
		let cancelled = false;
		await expect(
			readJsonBody(
				streaming([encode('"éé'), encode('é"'), encode("x")], () => {
					cancelled = true;
				}),
				4,
			),
		).rejects.toMatchObject({ status: 413 });
		expect(cancelled).toBe(true);
	});
	it("rejects advertised overflow before reading", async () => {
		let cancelled = false;
		const request = streaming([], () => {
			cancelled = true;
		});
		request.headers.set("content-length", "100");
		await expect(readJsonBody(request, 4)).rejects.toMatchObject({
			status: 413,
		});
		expect(cancelled).toBe(true);
	});
	it("bounds stalled reads even when cancellation never resolves", async () => {
		const request = new Request("https://fixture.invalid", {
			method: "POST",
			duplex: "half",
			body: new ReadableStream({ cancel: () => new Promise(() => {}) }),
		} as RequestInit);
		await expect(readJsonBody(request, 4, 10)).rejects.toMatchObject({
			status: 408,
		});
	});
	it("uses a total deadline even after receiving a chunk", async () => {
		const request = new Request("https://fixture.invalid", {
			method: "POST",
			duplex: "half",
			body: new ReadableStream({
				start(c) {
					c.enqueue(encode("{"));
				},
			}),
		} as RequestInit);
		await expect(readJsonBody(request, 4, 10)).rejects.toMatchObject({
			status: 408,
		});
	});
	it.each([encode("{"), new Uint8Array([0xff]), encode("")])(
		"rejects invalid JSON/UTF-8",
		async (bytes) => {
			await expect(readJsonBody(streaming([bytes]), 10)).rejects.toMatchObject({
				status: 400,
			});
		},
	);
	it("bounds an endless stream of immediately available empty chunks", async () => {
		const request = new Request("https://fixture.invalid", {
			method: "POST",
			duplex: "half",
			body: new ReadableStream({
				pull(c) {
					c.enqueue(new Uint8Array());
				},
			}),
		} as RequestInit);
		await expect(readJsonBody(request, 4, 10)).rejects.toMatchObject({
			status: 408,
		});
	});
	it("maps a failed stream to a bounded client error", async () => {
		const request = new Request("https://fixture.invalid", {
			method: "POST",
			duplex: "half",
			body: new ReadableStream({
				start(c) {
					c.error(new Error("private transport error"));
				},
			}),
		} as RequestInit);
		await expect(readJsonBody(request, 4)).rejects.toMatchObject({
			status: 400,
			message: "Invalid JSON body",
		});
	});
});
