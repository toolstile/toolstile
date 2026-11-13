import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpGateway, type Runtime } from "../packages/gateway/src/index";

// Proxies such as Cloudflare close connections that stay silent for about
// 100 seconds. The MCP SDK transport writes SSE comments while streams idle;
// these tests keep that guarantee visible through the gateway's own wrapping.
const runtime: Runtime = {
	sessionKey: "owner:keepalive-agent",
	connections: async () => [],
	admit: async () => {},
	record: async () => {},
	validateDestination: async () => {},
};
const protocol = "2025-11-25";

async function openSession(gateway: ReturnType<typeof createMcpGateway>) {
	const initialize = await gateway.handle(
		new Request("https://gateway/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": protocol,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: protocol,
					capabilities: {},
					clientInfo: { name: "keepalive", version: "1" },
				},
			}),
		}),
		runtime,
	);
	expect(initialize.status).toBe(200);
	expect(initialize.headers.get("content-type")).toContain("text/event-stream");
	expect(initialize.headers.get("cache-control")).toBe(
		"no-cache, no-transform",
	);
	expect(initialize.headers.get("x-accel-buffering")).toBe("no");
	await initialize.text();
	const session = initialize.headers.get("mcp-session-id");
	if (!session) throw new Error("Missing session");
	const headers = {
		"MCP-Protocol-Version": protocol,
		"Mcp-Session-Id": session,
	};
	const initialized = await gateway.handle(
		new Request("https://gateway/mcp", {
			method: "POST",
			headers: {
				...headers,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/initialized",
			}),
		}),
		runtime,
	);
	expect(initialized.status).toBe(202);
	return headers;
}

describe("SDK keepalive behavior through gateway stream wrapping", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("send keepalive comments well inside proxy idle limits and stop on close", async () => {
		const gateway = createMcpGateway();
		try {
			const headers = await openSession(gateway);
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const stream = await gateway.handle(
				new Request("https://gateway/mcp", {
					headers: { ...headers, Accept: "text/event-stream" },
				}),
				runtime,
			);
			expect(stream.status).toBe(200);
			expect(stream.headers.get("cache-control")).toBe(
				"no-cache, no-transform",
			);
			expect(stream.headers.get("x-accel-buffering")).toBe("no");
			expect(stream.headers.has("connection")).toBe(false);
			if (!stream.body) throw new Error("Missing stream body");
			const reader = stream.body.getReader(),
				decoder = new TextDecoder();
			expect(vi.getTimerCount()).toBe(1);
			for (let tick = 0; tick < 7; tick++) {
				const next = reader.read();
				await vi.advanceTimersByTimeAsync(15_000);
				expect(decoder.decode((await next).value)).toBe(": keepalive\n\n");
			}
			await reader.cancel();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
			await gateway.close();
		}
	});
});
