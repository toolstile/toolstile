import { describe, expect, it, vi } from "vitest";
import {
	detectConnection,
	emptyRules,
	invoke,
	openUpstream,
	type Runtime,
	type Upstream,
} from "../packages/gateway/src/index";
import { defined } from "./assertions";
import { fixture } from "./session-fixture";

describe("upstream session cleanup", () => {
	it.each(["invoke", "failed invoke", "direct client", "probe"] as const)(
		"terminates the stateful HTTP session after %s",
		async (path) => {
			const f = fixture();
			const upstream: Upstream = {
				id: "a",
				label: "Stateful",
				url: "https://fixture/mcp",
				transport: "http",
				headers: {},
				rules: [{ ...emptyRules(), full: true }],
			};
			const runtime: Runtime = {
				connections: async () => [upstream],
				admit: async () => {},
				record: async () => {},
				validateDestination: async () => {},
				fetch: f.request,
			};
			let sessionId: string | undefined;
			const work = async (client: Awaited<ReturnType<typeof openUpstream>>) => {
				await client.listResources();
				sessionId = f.upstreams.find((entry) => entry.transport.sessionId)
					?.transport.sessionId;
				if (path === "failed invoke") throw new Error("work failed");
			};
			try {
				if (path === "probe") {
					const send: typeof fetch = async (input, init) => {
						const response = await f.request(input, init);
						sessionId ??= response.headers.get("mcp-session-id") ?? undefined;
						return response;
					};
					expect(
						(await detectConnection({ url: upstream.url, fetch: send })).status,
					).toBe("reachable");
				} else if (path === "direct client") {
					const client = await openUpstream(
						runtime,
						upstream,
						"resources/list",
						undefined,
						"resources",
					);
					try {
						await work(client);
					} finally {
						await client.close();
					}
				} else {
					const result = invoke(
						runtime,
						upstream,
						"resources/list",
						undefined,
						work,
						"resources",
					);
					if (path === "failed invoke")
						await expect(result).rejects.toThrow("work failed");
					else await result;
				}
				expect(sessionId).toBeTruthy();
				expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
				const response = await f.request(upstream.url, {
					method: "POST",
					headers: {
						"mcp-session-id": defined(sessionId),
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 42,
						method: "resources/list",
					}),
				});
				expect(response.status).toBe(404);
				await response.body?.cancel();
			} finally {
				await f.close();
			}
		},
	);
	it.each([404, 405, "network", "timeout"] as const)(
		"tolerates termination failure %s and bounds cleanup",
		async (failure) => {
			const f = fixture();
			const upstream: Upstream = {
				id: "a",
				label: "Stateful",
				url: "https://fixture/mcp",
				transport: "http",
				headers: {},
				rules: [{ ...emptyRules(), full: true }],
			};
			let deletes = 0,
				aborted = false;
			const runtime: Runtime = {
				connections: async () => [upstream],
				admit: async () => {},
				record: async () => {},
				validateDestination: async () => {},
				fetch: async (input, init) => {
					if (init?.method !== "DELETE") return f.request(input, init);
					deletes++;
					if (failure === "network") throw new Error("network unavailable");
					if (failure === "timeout")
						return new Promise<Response>((_resolve, reject) => {
							const abort = () => {
								aborted = true;
								reject(new Error("aborted"));
							};
							init.signal?.addEventListener("abort", abort, { once: true });
							if (init.signal?.aborted) abort();
						});
					return new Response(null, { status: failure });
				},
			};
			try {
				const started = performance.now();
				await expect(
					invoke(
						runtime,
						upstream,
						"resources/list",
						undefined,
						(client) => client.listResources(),
						"resources",
					),
				).resolves.toHaveProperty("resources");
				expect(deletes).toBe(1);
				if (failure === "timeout") {
					expect(performance.now() - started).toBeLessThan(3000);
					await vi.waitFor(() => expect(aborted).toBe(true));
				}
			} finally {
				await f.close();
			}
		},
	);
});
