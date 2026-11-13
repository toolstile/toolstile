import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
	SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
	alias,
	createMcpGateway,
	emptyRules,
	type Operation,
	operationCapability,
	permitted,
	type Runtime,
	resourceAlias,
	resourceTemplateAlias,
} from "../packages/gateway/src/index";
import { serveFixture, startSessionFixture } from "./session-fixture";
import { subscriptionFixture } from "./subscription-fixture";

async function setup(
	legacySse = false,
	options: Parameters<typeof createMcpGateway>[0] = {},
) {
	const fixture = await subscriptionFixture(legacySse);
	const rules = emptyRules();
	rules.full = true;
	let active = true,
		identity = "first";
	const operations: Operation[] = [];
	const checks: string[] = [];
	const runtime: Runtime = {
		sessionKey: "owner:agent",
		authenticate: async () => {
			if (!active) throw new Error("Revoked");
		},
		connections: async () => [
			{
				id: "a",
				identityKey: identity,
				label: "Fixture source",
				url: fixture.url,
				transport: legacySse ? "sse" : "http",
				headers: {},
				rules: [rules],
			},
		],
		admit: async (operation) => {
			const kind = operationCapability(operation);
			if (
				!active ||
				!kind ||
				(operation.target && !permitted([rules], kind, operation.target))
			)
				throw new Error("Denied");
			operations.push(operation);
		},
		check: async (_id, kind, target) => {
			if (!active || !kind || (target && !permitted([rules], kind, target)))
				throw new Error("Denied");
			checks.push(`${kind}:${target ?? "list"}`);
		},
		record: async () => {},
		validateDestination: async () => {},
	};
	const gateway = createMcpGateway(options);
	const http = await serveFixture((input, init) =>
		gateway.handle(new Request(input, init), runtime),
	);
	async function agent(key = "owner:agent") {
		const client = new Client(
			{ name: key, version: "1" },
			{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(
				new URL(http.url),
				key === runtime.sessionKey
					? {}
					: {
							fetch: (input, init) =>
								gateway.handle(new Request(input, init), {
									...runtime,
									sessionKey: key,
								}),
						},
			),
		);
		return client;
	}
	return {
		fixture,
		gateway,
		runtime,
		rules,
		operations,
		checks,
		agent,
		revoke() {
			active = false;
		},
		changeIdentity() {
			identity = "second";
		},
		async close() {
			await gateway.close();
			await fixture.close();
			await http.close();
		},
	};
}
const uri = resourceAlias("a", "docs://one");

describe("modern subscriptions over HTTP", () => {
	for (const legacySse of [false, true])
		it(`forwards filtered updates and catalog changes from ${legacySse ? "legacy HTTP+SSE" : "modern listen"} without exposing original URIs`, async () => {
			const s = await setup(legacySse),
				client = await s.agent();
			const updates: string[] = [],
				changes: string[] = [];
			client.setNotificationHandler(
				"notifications/resources/updated",
				(event) => {
					updates.push(event.params.uri);
				},
			);
			client.setNotificationHandler("notifications/tools/list_changed", () => {
				changes.push("tools");
			});
			client.setNotificationHandler(
				"notifications/resources/list_changed",
				() => {
					changes.push("resources");
				},
			);
			const expanded = resourceTemplateAlias("a", "docs://one");
			try {
				const subscription = await client.listen({
					toolsListChanged: true,
					resourcesListChanged: true,
					resourceSubscriptions: [uri, expanded],
				});
				expect(subscription.honoredFilter).toEqual({
					toolsListChanged: true,
					resourcesListChanged: true,
					resourceSubscriptions: [uri, expanded],
				});
				await s.fixture.publish({
					kind: "resource_updated",
					uri: "docs://other",
				});
				await s.fixture.publish({
					kind: "resource_updated",
					uri: "docs://one",
				});
				await s.fixture.publish({ kind: "tools_list_changed" });
				await s.fixture.publish({ kind: "resources_list_changed" });
				await vi.waitFor(() => {
					expect(new Set(updates)).toEqual(new Set([uri, expanded]));
					expect(changes).toEqual(["tools", "resources"]);
				});
				expect(s.operations.every((operation) => operation.maintenance)).toBe(
					true,
				);
				expect(s.checks).toContain("resources:docs://one");
				const result = await client.callTool({
					name: alias("a", "echo"),
					arguments: { text: "working" },
				});
				expect(result.content).toEqual([{ type: "text", text: "working" }]);
				expect(
					s.operations.filter(
						(operation) =>
							!operation.maintenance && operation.method === "tools/call",
					),
				).toHaveLength(1);
				await subscription.close();
				expect(await subscription.closed).toBe("local");
				await vi.waitFor(() => expect(s.gateway.subscriptionStreams).toBe(0));
				await vi.waitFor(() =>
					expect(
						legacySse ? s.fixture.sources.size : s.fixture.bus.listenerCount,
					).toBe(0),
				);
			} finally {
				await client.close();
				await s.close();
			}
		});

	for (const change of ["block", "identity", "authentication"] as const)
		it(`stops a live stream on ${change} changes and cleans up the source`, async () => {
			const s = await setup(),
				client = await s.agent();
			const updates: string[] = [];
			client.setNotificationHandler(
				"notifications/resources/updated",
				(event) => {
					updates.push(event.params.uri);
				},
			);
			try {
				const subscription = await client.listen({
					resourceSubscriptions: [uri],
				});
				if (change === "block") s.rules.block.resources.push("docs://one");
				else if (change === "identity") s.changeIdentity();
				else s.revoke();
				await s.fixture.publish({
					kind: "resource_updated",
					uri: "docs://one",
				});
				expect(await subscription.closed).toBe("remote");
				expect(updates).toEqual([]);
				await vi.waitFor(() => expect(s.fixture.bus.listenerCount).toBe(0));
				expect(s.gateway.subscriptionStreams).toBe(0);
			} finally {
				await client.close();
				await s.close();
			}
		});

	for (const legacySse of [false, true])
		it(`revokes one agent and permits explicit re-listen after ${legacySse ? "HTTP+SSE" : "modern"} source disconnect`, async () => {
			const s = await setup(legacySse),
				first = await s.agent(),
				second = await s.agent("owner:other");
			try {
				const a = await first.listen({ resourceSubscriptions: [uri] }),
					b = await second.listen({ resourceSubscriptions: [uri] });
				await s.gateway.revoke("owner:agent");
				expect(await a.closed).toBe("remote");
				expect(s.gateway.subscriptionStreams).toBe(1);
				await s.fixture.disconnect();
				expect(await b.closed).toBe("remote");
				await vi.waitFor(() => expect(s.gateway.subscriptionStreams).toBe(0));
				const next = await second.listen({ resourceSubscriptions: [uri] });
				expect(next.honoredFilter.resourceSubscriptions).toEqual([uri]);
				await next.close();
			} finally {
				await first.close();
				await second.close();
				await s.close();
			}
		});

	it("cancels a listen via AbortSignal and releases upstream connections", async () => {
		const s = await setup(),
			client = await s.agent();
		try {
			const abort = new AbortController();
			const subscription = await client.listen(
				{ resourceSubscriptions: [uri] },
				{ signal: abort.signal },
			);
			abort.abort();
			expect(await subscription.closed).toBe("local");
			await vi.waitFor(() => expect(s.gateway.subscriptionStreams).toBe(0));
			await vi.waitFor(() => expect(s.fixture.bus.listenerCount).toBe(0));
		} finally {
			await client.close();
			await s.close();
		}
	});

	it("bridges a legacy Streamable HTTP source and acknowledges only its supported notification filters", async () => {
		const legacy = await startSessionFixture(),
			s = await setup();
		const source = (await s.runtime.connections())[0];
		s.runtime.connections = async () => [{ ...source, url: legacy.url }];
		const client = await s.agent(),
			updates: string[] = [];
		client.setNotificationHandler(
			"notifications/resources/updated",
			(notification) => {
				updates.push(notification.params.uri);
			},
		);
		try {
			const subscription = await client.listen({
				toolsListChanged: true,
				promptsListChanged: true,
				resourcesListChanged: true,
				resourceSubscriptions: [uri],
			});
			expect(subscription.honoredFilter).toEqual({
				resourcesListChanged: true,
				resourceSubscriptions: [uri],
			});
			await legacy.publish();
			await vi.waitFor(() => expect(updates).toEqual([uri]));
			const aborted = legacy.aborted();
			await subscription.close();
			await vi.waitFor(() => expect(legacy.aborted()).toBeGreaterThan(aborted));
		} finally {
			await client.close();
			await s.close();
			await legacy.close();
		}
	});

	it("sends acknowledgement first, stamps the request id, and re-listens without SSE replay", async () => {
		const s = await setup();
		async function open(id: number) {
			return s.gateway.handle(
				new Request("https://gateway/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"MCP-Protocol-Version": "2026-07-28",
						"Mcp-Method": "subscriptions/listen",
						"Last-Event-ID": "not-a-modern-cursor",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id,
						method: "subscriptions/listen",
						params: {
							notifications: { resourceSubscriptions: [uri] },
							_meta: {
								[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
								[CLIENT_INFO_META_KEY]: { name: "wire-fixture", version: "1" },
								[CLIENT_CAPABILITIES_META_KEY]: {},
							},
						},
					}),
				}),
				s.runtime,
			);
		}
		try {
			for (const id of [91, 92]) {
				const response = await open(id);
				expect(response.status).toBe(200);
				expect(response.headers.get("cache-control")).toBe(
					"no-cache, no-transform",
				);
				expect(response.headers.get("x-accel-buffering")).toBe("no");
				if (!response.body) throw new Error("Missing listen body");
				const reader = response.body.getReader(),
					decoder = new TextDecoder();
				try {
					const ack = decoder.decode((await reader.read()).value);
					expect(ack).not.toMatch(/^id:/m);
					const message = JSON.parse(ack.split("data: ")[1]);
					expect(message.method).toBe(
						"notifications/subscriptions/acknowledged",
					);
					expect(message.params._meta[SUBSCRIPTION_ID_META_KEY]).toBe(id);
					await s.fixture.publish({
						kind: "resource_updated",
						uri: "docs://one",
					});
					const frame = decoder.decode((await reader.read()).value);
					expect(frame).not.toMatch(/^id:/m);
					const event = JSON.parse(frame.split("data: ")[1]);
					expect(event.params.uri).toBe(uri);
					expect(event.params._meta[SUBSCRIPTION_ID_META_KEY]).toBe(id);
				} finally {
					await reader.cancel();
					reader.releaseLock();
				}
				await vi.waitFor(() => expect(s.fixture.bus.listenerCount).toBe(0));
				await s.fixture.publish({
					kind: "resource_updated",
					uri: "docs://one",
				});
			}
		} finally {
			await s.close();
		}
	});

	it("sends a graceful completion on gateway shutdown", async () => {
		const s = await setup(),
			client = await s.agent();
		try {
			const subscription = await client.listen({ toolsListChanged: true });
			await s.gateway.close();
			expect(await subscription.closed).toBe("graceful");
			await vi.waitFor(() => expect(s.fixture.bus.listenerCount).toBe(0));
		} finally {
			await client.close();
			await s.close();
		}
	});

	it("accepts a framework request wrapper without relying on the native Request constructor brand", async () => {
		const s = await setup();
		const client = new Client(
			{ name: "framework-fixture", version: "1" },
			{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
		);
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL("https://gateway/mcp"), {
					fetch: (input, init) => {
						const request = new Request(input, init);
						const wrapped = {
							url: request.url,
							method: request.method,
							headers: request.headers,
							get body() {
								return request.body;
							},
							signal: request.signal,
							clone: () => request.clone(),
						} as Request;
						return s.gateway.handle(wrapped, s.runtime);
					},
				}),
			);
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
				[alias("a", "echo")],
			);
		} finally {
			await client.close();
			await s.close();
		}
	});

	it("rejects denied resources before an acknowledgement and bounds per-agent stream capacity", async () => {
		const s = await setup(false, { maxSubscriptionStreamsPerAgent: 1 }),
			client = await s.agent();
		try {
			s.rules.block.resources.push("docs://one");
			await expect(
				client.listen({ resourceSubscriptions: [uri] }),
			).rejects.toThrow("Resource unavailable");
			expect(s.gateway.subscriptionStreams).toBe(0);
			s.rules.block.resources.length = 0;
			const subscription = await client.listen({
				resourceSubscriptions: [uri],
			});
			await expect(client.listen({ toolsListChanged: true })).rejects.toThrow(
				"Subscription capacity",
			);
			await subscription.close();
			await vi.waitFor(() => expect(s.gateway.subscriptionStreams).toBe(0));
			const retry = await client.listen({ toolsListChanged: true });
			await retry.close();
		} finally {
			await client.close();
			await s.close();
		}
	});
});
