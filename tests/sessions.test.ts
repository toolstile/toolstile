import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
	alias,
	createMcpGateway,
	emptyRules,
	operationCapability,
	permitted,
	type Runtime,
	resourceAlias,
	resourceTemplateAlias,
} from "../packages/gateway/src/index";
import { sessionHandler } from "../packages/gateway/src/sessions";
import { defined } from "./assertions";
import { fixture as sessionFixture } from "./session-fixture";

const fixture = sessionFixture;

function setup() {
	const f = fixture(),
		rules = emptyRules();
	rules.full = true;
	let identity = "account-one",
		active = true;
	const source = () => ({
		id: "a",
		identityKey: identity,
		label: "Private source",
		url: "https://fixture/mcp",
		transport: "http",
		headers: {},
		rules: [rules],
	});
	const runtime: Runtime = {
		sessionKey: "owner:agent-a",
		authenticate: async () => {
			if (!active) throw new Error("revoked");
		},
		connections: async () => [source()],
		check: async (_id, kind, target) => {
			if (!active || !kind || (target && !permitted([rules], kind, target)))
				throw new Error("denied");
		},
		admit: async (operation) => {
			const kind = operationCapability(operation);
			if (
				!active ||
				!kind ||
				(operation.target && !permitted([rules], kind, operation.target))
			)
				throw new Error("denied");
		},
		record: async () => {},
		validateDestination: async () => {},
		fetch: f.request,
	};
	const gateway = createMcpGateway();
	return {
		f,
		runtime,
		gateway,
		rules,
		changeIdentity: () => {
			identity = "account-two";
		},
		revoke: () => {
			active = false;
		},
	};
}
async function agent(
	state: ReturnType<typeof setup>,
	name: string,
	runtime = state.runtime,
) {
	const client = new Client(
		{ name, version: "1" },
		{ capabilities: { roots: {}, sampling: {}, elicitation: { form: {} } } },
	);
	client.setRequestHandler("roots/list", async () => ({
		roots: [{ uri: `file:///${name}` }],
	}));
	client.setRequestHandler("sampling/createMessage", async () => ({
		model: name,
		role: "assistant",
		content: { type: "text", text: `sample-${name}` },
	}));
	client.setRequestHandler("elicitation/create", async (request) => {
		expect(request.params.message).toContain("Private source");
		return { action: "decline" };
	});
	const transport = new StreamableHTTPClientTransport(
		new URL("https://gateway/mcp"),
		{
			fetch: (input, init) =>
				state.gateway.handle(
					new Request(
						input instanceof Request ? input.url : String(input),
						init,
					),
					runtime,
				),
		},
	);
	await client.connect(transport);
	return { client, transport };
}

describe("authenticated stateful MCP forwarding", () => {
	it("routes concurrent nested consent, sampling and roots to the originating agent", async () => {
		const s = setup();
		const a = await agent(s, "agent-a"),
			b = await agent(s, "agent-b", {
				...s.runtime,
				sessionKey: "owner:agent-b",
			});
		try {
			expect(a.transport.sessionId).toBeTruthy();
			expect(s.gateway.size).toBe(2);
			const progress: number[] = [];
			const [first, second] = await Promise.all([
				a.client.callTool(
					{ name: alias("a", "interactive"), arguments: {} },
					{
						onprogress: (event) => {
							progress.push(event.progress);
						},
					},
				),
				b.client.callTool({ name: alias("a", "interactive"), arguments: {} }),
			]);
			expect(JSON.stringify(first)).toContain("sample-agent-a");
			expect(JSON.stringify(first)).not.toContain("sample-agent-b");
			expect(JSON.stringify(second)).toContain("sample-agent-b");
			expect(s.f.callbacks).toEqual(["decline", "decline"]);
			expect(progress).toEqual([1]);
			const stolen = await s.gateway.handle(
				new Request("https://gateway/mcp", {
					headers: {
						"mcp-session-id": defined(a.transport.sessionId),
						Accept: "text/event-stream",
					},
				}),
				{ ...s.runtime, sessionKey: "another:agent" },
			);
			expect(stolen.status).toBe(404);
		} finally {
			await a.client.close();
			await b.client.close();
			await s.gateway.close();
			await s.f.close();
		}
	});
	it("does not return consent data after the account or permission changes during the question", async () => {
		for (const mode of ["account", "permission"] as const) {
			const s = setup(),
				a = await agent(s, mode);
			a.client.setRequestHandler("roots/list", async () => {
				if (mode === "account") s.changeIdentity();
				else s.rules.block.tools.push("roots_only");
				return { roots: [{ uri: "file:///private-answer" }] };
			});
			try {
				await expect(
					a.client.callTool({ name: alias("a", "roots_only"), arguments: {} }),
				).rejects.toThrow();
				expect(s.f.seen).toEqual([]);
			} finally {
				await a.client.close();
				await s.gateway.close();
				await s.f.close();
			}
		}
	});
	it("keeps a resource subscription alive, remaps updates and suppresses updates after a block", async () => {
		const s = setup(),
			a = await agent(s, "subscriber");
		const updates: string[] = [];
		a.client.setNotificationHandler(
			"notifications/resources/updated",
			(notification) => {
				updates.push(notification.params.uri);
			},
		);
		try {
			expect(a.client.getServerCapabilities()?.resources?.subscribe).toBe(true);
			await a.client.subscribeResource({
				uri: resourceAlias("a", "docs://one"),
			});
			await s.f.publish();
			await vi.waitFor(
				() => expect(updates).toEqual([resourceAlias("a", "docs://one")]),
				{ timeout: 3000 },
			);
			const before = s.f.aborted();
			s.rules.block.resources.push("docs://one");
			await s.f.publish();
			await vi.waitFor(() => expect(s.f.aborted()).toBeGreaterThan(before), {
				timeout: 3000,
			});
			expect(updates).toHaveLength(1);
		} finally {
			await a.client.close();
			await s.gateway.close();
			await s.f.close();
		}
	});
	it("unsubscribes explicitly and discards an old account's update after preference changes", async () => {
		const s = setup(),
			a = await agent(s, "unsubscribe");
		const updates: string[] = [];
		a.client.setNotificationHandler(
			"notifications/resources/updated",
			(notification) => {
				updates.push(notification.params.uri);
			},
		);
		try {
			const uri = resourceAlias("a", "docs://one");
			const expanded = resourceTemplateAlias("a", "docs://one");
			await a.client.subscribeResource({ uri });
			await a.client.subscribeResource({ uri: expanded });
			await s.f.publish();
			await vi.waitFor(() =>
				expect(new Set(updates)).toEqual(new Set([uri, expanded])),
			);
			await a.client.unsubscribeResource({ uri });
			expect(s.f.upstreams.some((entry) => entry.subscribed.size)).toBe(true);
			await a.client.unsubscribeResource({ uri: expanded });
			updates.length = 0;
			expect(s.f.upstreams.every((entry) => !entry.subscribed.size)).toBe(true);
			await a.client.subscribeResource({ uri });
			const before = s.f.aborted();
			s.changeIdentity();
			await s.f.publish();
			await vi.waitFor(() => expect(s.f.aborted()).toBeGreaterThan(before), {
				timeout: 3000,
			});
			expect(updates).toEqual([]);
		} finally {
			await a.client.close();
			await s.gateway.close();
			await s.f.close();
		}
	});
	it("expires idle sessions and enforces transport capacity without changing agent grants", async () => {
		const s = setup();
		await s.gateway.close();
		s.gateway = createMcpGateway({
			idleMs: 100,
			maxSessions: 1,
			maxSessionsPerAgent: 1,
			maxSessionsPerOwner: 1,
		});
		const a = await agent(s, "expiry");
		try {
			await expect(agent(s, "capacity")).rejects.toThrow();
			await vi.waitFor(() => expect(s.gateway.size).toBe(0), { timeout: 3000 });
			const response = await s.gateway.handle(
				new Request("https://gateway/mcp", {
					headers: {
						"mcp-session-id": defined(a.transport.sessionId),
						Accept: "text/event-stream",
					},
				}),
				s.runtime,
			);
			expect(response.status).toBe(404);
			const replacement = await agent(s, "replacement");
			await replacement.client.close();
		} finally {
			await a.client.close();
			await s.gateway.close();
			await s.f.close();
		}
	});

	it("limits one agent independently of other agents belonging to the same owner", async () => {
		const s = setup();
		await s.gateway.close();
		s.gateway = createMcpGateway({
			maxSessionsPerAgent: 1,
			maxSessionsPerOwner: 3,
		});
		const clients: Awaited<ReturnType<typeof agent>>[] = [];
		try {
			clients.push(await agent(s, "first"));
			await expect(agent(s, "same-agent")).rejects.toThrow(
				"Gateway session capacity reached",
			);
			clients.push(
				await agent(s, "other-agent", {
					...s.runtime,
					sessionKey: "owner:agent-b",
				}),
			);
			expect(s.gateway.size).toBe(2);
		} finally {
			await Promise.all(clients.map((a) => a.client.close()));
			await s.gateway.close();
			await s.f.close();
		}
	});
	it("limits an owner across agents while leaving other owners available", async () => {
		const s = setup();
		await s.gateway.close();
		s.gateway = createMcpGateway({ maxSessionsPerOwner: 2 });
		const clients: Awaited<ReturnType<typeof agent>>[] = [];
		try {
			for (const key of ["user:scope:one", "user:scope:two"])
				clients.push(await agent(s, key, { ...s.runtime, sessionKey: key }));
			await expect(
				agent(s, "third", { ...s.runtime, sessionKey: "user:scope:three" }),
			).rejects.toThrow("Gateway session capacity reached");
			clients.push(
				await agent(s, "other-scope", {
					...s.runtime,
					sessionKey: "user:other-scope:one",
				}),
			);
		} finally {
			await Promise.all(clients.map((a) => a.client.close()));
			await s.gateway.close();
			await s.f.close();
		}
	});
	it("limits initialization to 60 per minute per agent even after session deletion, and refills tokens", async () => {
		const s = setup();
		const clock = vi.spyOn(Date, "now");
		const now = Date.now();
		clock.mockReturnValue(now);
		const initialize = (key = s.runtime.sessionKey) =>
			s.gateway.handle(
				new Request("https://gateway/mcp", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "limit", version: "1" },
						},
					}),
				}),
				{ ...s.runtime, sessionKey: key },
			);
		try {
			for (let i = 0; i < 60; i++) {
				const r = await initialize();
				expect(r.status).toBe(200);
				await r.body?.cancel();
				await s.gateway.revoke(defined(s.runtime.sessionKey));
			}
			const limited = await initialize();
			expect(limited.status).toBe(503);
			expect(await limited.text()).toBe("Gateway session capacity reached");
			const other = await initialize("owner:other-agent");
			expect(other.status).toBe(200);
			await other.body?.cancel();
			clock.mockReturnValue(now + 1000);
			const refilled = await initialize();
			expect(refilled.status).toBe(200);
			await refilled.body?.cancel();
		} finally {
			clock.mockRestore();
			await s.gateway.close();
			await s.f.close();
		}
	});

	it("terminates an authenticated session on DELETE", async () => {
		const s = setup(),
			a = await agent(s, "delete");
		try {
			const response = await s.gateway.handle(
				new Request("https://gateway/mcp", {
					method: "DELETE",
					headers: { "mcp-session-id": defined(a.transport.sessionId) },
				}),
				s.runtime,
			);
			expect(response.status).toBe(200);
			expect(s.gateway.size).toBe(0);
		} finally {
			await a.client.close();
			await s.gateway.close();
			await s.f.close();
		}
	});
});

it.each(["maxSessionsPerAgent", "maxSessionsPerOwner"] as const)(
	"counts pending initializations against %s",
	async (limit) => {
		const s = setup();
		let release!: () => void, entered!: () => void;
		const waiting = new Promise<void>((r) => {
			release = r;
		});
		const started = new Promise<void>((r) => {
			entered = r;
		});
		const registry = sessionHandler(
			() => {
				const server = new Server({ name: "pending", version: "1" });
				const connect = server.connect.bind(server);
				server.connect = async (...args) => {
					entered();
					await waiting;
					return connect(...args);
				};
				return server;
			},
			async () => new Response(null, { status: 400 }),
			{ [limit]: 1 },
		);
		const request = () =>
			new Request("https://gateway/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "pending", version: "1" },
					},
				}),
			});
		const first = registry.handle(request(), s.runtime);
		await started;
		try {
			const second = registry.handle(request(), {
				...s.runtime,
				sessionKey:
					limit === "maxSessionsPerOwner"
						? "owner:second-agent"
						: s.runtime.sessionKey,
			});
			// A missing pending reservation starts a second server instead of rejecting.
			release();
			const response = await second;
			expect(response.status).toBe(503);
			expect(await response.text()).toBe("Gateway session capacity reached");
		} finally {
			release();
			const response = await first;
			await response.body?.cancel();
			await registry.close();
			await s.gateway.close();
			await s.f.close();
		}
	},
);
