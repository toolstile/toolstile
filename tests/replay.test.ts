import { describe, expect, it, vi } from "vitest";
import {
	alias,
	createMcpGateway,
	emptyRules,
	type Operation,
	type Runtime,
	resourceAlias,
} from "../packages/gateway/src/index";
import { serveFixture } from "./session-fixture";
import { subscriptionFixture } from "./subscription-fixture";

type Frame = {
	id?: string;
	data:
		| {
				method?: string;
				params?: { uri?: string; _meta?: Record<string, unknown> };
				result?: unknown;
		  }
		| undefined;
};
function sse(response: Response) {
	if (!response.body) throw new Error("SSE response body missing");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	return {
		async next(): Promise<Frame> {
			for (;;) {
				const end = pending.indexOf("\n\n");
				if (end >= 0) {
					const frame = pending.slice(0, end);
					pending = pending.slice(end + 2);
					if (!frame.includes("data:")) continue;
					const data = /^data: *(.*)$/m.exec(frame)?.[1];
					return {
						id: /^id: (.+)$/m.exec(frame)?.[1],
						data: data ? JSON.parse(data) : undefined,
					};
				}
				const next = await reader.read();
				if (next.done) throw new Error("Stream ended");
				pending += decoder.decode(next.value, { stream: true });
			}
		},
		async close() {
			await reader.cancel();
			reader.releaseLock();
		},
	};
}
async function setup(
	options: Parameters<typeof createMcpGateway>[0] = {},
	legacySse = false,
) {
	const fixture = await subscriptionFixture(legacySse),
		rules = emptyRules();
	rules.full = true;
	let identity = "one",
		allowed = true;
	const operations: Operation[] = [];
	const runtime: Runtime = {
		sessionKey: "owner:agent",
		connections: async () => [
			{
				id: "a",
				identityKey: identity,
				label: "Fixture",
				url: fixture.url,
				transport: legacySse ? "sse" : "http",
				headers: {},
				rules: [rules],
			},
		],
		check: async () => {
			if (!allowed) throw new Error("Revoked");
		},
		admit: async (operation) => {
			if (!allowed) throw new Error("Revoked");
			operations.push(operation);
		},
		record: async () => {},
		validateDestination: async () => {},
	};
	const gateway = createMcpGateway(options);
	const http = await serveFixture((input, init) =>
		gateway.handle(new Request(input, init), runtime),
	);
	let rpcId = 0;
	async function post(
		method: string,
		params: Record<string, unknown>,
		session?: string,
	) {
		return fetch(http.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2025-11-25",
				...(session ? { "mcp-session-id": session } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
		});
	}
	async function initialize() {
		const response = await post("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: { roots: {} },
			clientInfo: { name: "legacy-fixture", version: "1" },
		});
		const session = response.headers.get("mcp-session-id");
		if (!session) throw new Error("Session missing");
		await response.text();
		expect(session).toBeTruthy();
		return session;
	}
	async function get(session: string, cursor?: string) {
		return fetch(http.url, {
			headers: {
				Accept: "text/event-stream",
				"MCP-Protocol-Version": "2025-11-25",
				"mcp-session-id": session,
				...(cursor ? { "Last-Event-ID": cursor } : {}),
			},
		});
	}
	return {
		fixture,
		gateway,
		runtime,
		rules,
		operations,
		post,
		get,
		initialize,
		changeIdentity() {
			identity = "two";
		},
		deny() {
			allowed = false;
		},
		async close() {
			await gateway.close();
			await fixture.close();
			await http.close();
		},
	};
}
const uri = resourceAlias("a", "docs://one");

describe("legacy authenticated session replay over HTTP", () => {
	it("bridges a modern source, replays missed resource updates, and continues live delivery without re-subscribing", async () => {
		const s = await setup();
		let stream: ReturnType<typeof sse> | undefined;
		try {
			const session = await s.initialize();
			expect(
				await (await s.post("resources/subscribe", { uri }, session)).text(),
			).toContain('"result"');
			stream = sse(await s.get(session));
			await s.fixture.publish({ kind: "resource_updated", uri: "docs://one" });
			const first = await stream.next();
			expect(first.id).toBeTruthy();
			expect(first.data?.params?.uri).toBe(uri);
			await stream.close();
			stream = undefined;
			await s.fixture.publish({ kind: "resource_updated", uri: "docs://one" });
			await vi.waitFor(() => expect(s.gateway.size).toBe(1));
			// HTTP cancellation reaches the server asynchronously. Resume only after
			// its old connection has detached; an active stream must remain a 409.
			const response = await vi.waitFor(async () => {
				const response = await s.get(session, first.id);
				if (response.status === 409) {
					expect(await response.text()).toContain("active connection");
					throw new Error("Previous SSE connection is still detaching");
				}
				expect(response.status).toBe(200);
				return response;
			});
			stream = sse(response);
			const replay = await stream.next();
			expect(replay.id).not.toBe(first.id);
			expect(replay.data?.params?.uri).toBe(uri);
			await s.fixture.publish({ kind: "resource_updated", uri: "docs://one" });
			expect((await stream.next()).data?.params?.uri).toBe(uri);
			expect(
				s.fixture.calls.filter(
					(call) => call.method === "subscriptions/listen",
				),
			).toHaveLength(1);
			await stream.close();
			stream = undefined;
			await (await s.post("resources/unsubscribe", { uri }, session)).text();
			await vi.waitFor(() => expect(s.fixture.bus.listenerCount).toBe(0));
		} finally {
			await stream?.close();
			await s.close();
		}
	});

	it("re-delivers a completed tool response without executing or admitting the tool twice", async () => {
		const s = await setup();
		try {
			const session = await s.initialize();
			const response = await s.post(
				"tools/call",
				{ name: alias("a", "echo"), arguments: { text: "once" } },
				session,
			);
			const text = await response.text();
			const cursor = /^id: (.+)$/m.exec(text)?.[1];
			expect(cursor).toBeTruthy();
			const replay = await s.get(session, cursor);
			expect(replay.status).toBe(200);
			expect(await replay.text()).toContain('"text":"once"');
			expect(
				s.fixture.calls.filter((call) => call.method === "tools/call"),
			).toHaveLength(1);
			expect(
				s.operations.filter(
					(operation) =>
						!operation.maintenance && operation.method === "tools/call",
				),
			).toHaveLength(1);
		} finally {
			await s.close();
		}
	});

	it("refuses to replay a stream containing a server-initiated question", async () => {
		const s = await setup({}, true);
		try {
			const session = await s.initialize();
			const stream = sse(
				await s.post(
					"tools/call",
					{ name: alias("a", "echo"), arguments: { ask: true } },
					session,
				),
			);
			const priming = await stream.next();
			expect(priming.id).toBeTruthy();
			expect((await stream.next()).data?.method).toBe("roots/list");
			await stream.close();
			const replay = await s.get(session, priming.id);
			expect(replay.status).toBe(409);
			expect(await replay.text()).not.toContain("roots/list");
		} finally {
			await s.close();
		}
	});

	for (const change of ["block", "account", "live check"] as const)
		it(`rejects retained data after ${change} changes`, async () => {
			const s = await setup();
			try {
				const session = await s.initialize();
				await (await s.post("resources/subscribe", { uri }, session)).text();
				const stream = sse(await s.get(session));
				await s.fixture.publish({
					kind: "resource_updated",
					uri: "docs://one",
				});
				const first = await stream.next();
				await stream.close();
				if (change === "block") s.rules.block.resources.push("docs://one");
				else if (change === "account") s.changeIdentity();
				else s.deny();
				const response = await s.get(session, first.id);
				expect(response.status).toBe(409);
				expect(await response.text()).not.toContain("docs://one");
			} finally {
				await s.close();
			}
		});

	it("rejects unknown, cross-session, expired and evicted cursors and closes sessions on revocation", async () => {
		const s = await setup({ replayMaxEvents: 2, replayTtlMs: 100 });
		try {
			const session = await s.initialize(),
				other = await s.initialize();
			await (await s.post("resources/subscribe", { uri }, session)).text();
			const stream = sse(await s.get(session));
			await s.fixture.publish({ kind: "resource_updated", uri: "docs://one" });
			const first = await stream.next();
			expect((await s.get(other, first.id)).status).toBe(409);
			expect((await s.get(session, "unknown-cursor")).status).toBe(409);
			for (let i = 0; i < 2; i++) {
				await s.fixture.publish({
					kind: "resource_updated",
					uri: "docs://one",
				});
				await stream.next();
			}
			await stream.close();
			expect((await s.get(session, first.id)).status).toBe(409);
			await s.gateway.revoke("owner:agent");
			expect((await s.get(session, first.id)).status).toBe(404);
		} finally {
			await s.close();
		}
		const expiry = await setup({ replayTtlMs: 25 });
		try {
			const session = await expiry.initialize();
			const response = await expiry.post(
				"tools/call",
				{ name: alias("a", "echo") },
				session,
			);
			const cursor = /^id: (.+)$/m.exec(await response.text())?.[1];
			// Jump the clock past the TTL instead of racing a real sleep against it.
			vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1_000 });
			expect((await expiry.get(session, cursor)).status).toBe(409);
		} finally {
			vi.useRealTimers();
			await expiry.close();
		}
	});
});
