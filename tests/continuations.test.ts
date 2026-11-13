import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
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
} from "../packages/gateway/src/index";
import { modernFixture } from "./modern-fixture";
import { fixture as legacyFixture } from "./session-fixture";

const caps = { roots: {}, sampling: {}, elicitation: { form: {} } };
function setup(
	modern = true,
	options: Parameters<typeof createMcpGateway>[0] = {},
) {
	const fixture = modern ? modernFixture() : legacyFixture();
	const rules = emptyRules();
	rules.full = true;
	let active = true,
		identity = "one";
	const operations: Operation[] = [];
	const runtime: Runtime = {
		sessionKey: "owner:agent",
		authenticate: async () => {
			if (!active) throw new Error("revoked");
		},
		connections: async () => [
			{
				id: "a",
				identityKey: identity,
				label: "Private source",
				url: "https://fixture/mcp",
				transport: "http",
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
				throw new Error("denied");
			if (!operation.maintenance) operations.push(operation);
		},
		record: async () => {},
		validateDestination: async () => {},
		fetch: fixture.request,
	};
	const gateway = createMcpGateway(options);
	return {
		fixture,
		gateway,
		runtime,
		rules,
		operations,
		changeIdentity: () => {
			identity = "two";
		},
		revoke: () => {
			active = false;
		},
		async close() {
			await gateway.close();
			if ("close" in fixture) await fixture.close();
		},
	};
}
async function agent(
	s: ReturnType<typeof setup>,
	modern: boolean,
	key = "owner:agent",
) {
	const client = new Client(
		{ name: key, version: "1" },
		{
			versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
			capabilities: caps,
		},
	);
	client.setRequestHandler("roots/list", async () => ({
		roots: [{ uri: `file:///${key}` }],
	}));
	client.setRequestHandler("sampling/createMessage", async () => ({
		role: "assistant",
		model: "local",
		content: { type: "text", text: key },
	}));
	client.setRequestHandler("elicitation/create", async (req) => {
		expect(req.params.message).toContain("Private source");
		return { action: "decline" };
	});
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://gateway/mcp"), {
			fetch: (input, init) =>
				s.gateway.handle(new Request(input, init), {
					...s.runtime,
					sessionKey: key,
				}),
		}),
	);
	return client;
}
let rpcId = 0;
async function raw(
	s: ReturnType<typeof setup>,
	params: Record<string, unknown>,
	overrides: Partial<Runtime> = {},
	method = "tools/call",
	signal?: AbortSignal,
) {
	const response = await s.gateway.handle(
		new Request("https://gateway/mcp", {
			method: "POST",
			signal,
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": method,
				...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++rpcId,
				method,
				params: {
					...params,
					_meta: {
						[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
						[CLIENT_CAPABILITIES_META_KEY]: caps,
						[CLIENT_INFO_META_KEY]: { name: "test", version: "1" },
					},
				},
			}),
		}),
		{ ...s.runtime, ...overrides },
	);
	const body = await response.text();
	if (signal?.aborted && !body) return { cancelled: true };
	return JSON.parse(body);
}
describe("cross-revision MCP input forwarding", () => {
	for (const upstream of [false, true])
		for (const downstream of [false, true]) {
			it(`${downstream ? "modern" : "legacy"} agent to ${upstream ? "modern" : "legacy"} source preserves input and consent`, async () => {
				const s = setup(upstream),
					client = await agent(s, downstream);
				try {
					const progress: number[] = [];
					const result = await client.callTool(
						{
							name: alias("a", "interactive"),
							arguments: {},
						},
						{
							onprogress: (event) => {
								progress.push(event.progress);
							},
						},
					);
					expect(result.isError).not.toBe(true);
					expect(JSON.stringify(result)).toContain("decline");
					expect(JSON.stringify(result)).toContain("file:///owner:agent");
					expect(s.gateway.pendingContinuations).toBe(0);
					expect(progress).toContain(1);
					expect(
						s.operations.some(
							(op) =>
								op.method === "server/discover" || op.method === "initialize",
						),
					).toBe(false);
					expect(
						s.operations.filter((op) => op.method === "tools/call"),
					).toHaveLength(upstream ? 3 : 1);
					if ("starts" in s.fixture) expect(s.fixture.starts()).toBe(1);
				} finally {
					await client.close();
					await s.close();
				}
			});
		}
	it("supports prompt and resource follow-up rounds and isolates concurrent agents", async () => {
		const s = setup(),
			a = await agent(s, true, "alice"),
			b = await agent(s, true, "bob");
		try {
			const [prompt, resource] = await Promise.all([
				a.getPrompt({ name: alias("a", "interactive") }),
				b.readResource({ uri: resourceAlias("a", "docs://one") }),
			]);
			expect(JSON.stringify(prompt)).toContain("file:///alice");
			expect(JSON.stringify(prompt)).not.toContain("file:///bob");
			expect(JSON.stringify(resource)).toContain("file:///bob");
			expect(JSON.stringify(resource)).not.toContain("file:///alice");
			expect(s.gateway.pendingContinuations).toBe(0);
		} finally {
			await a.close();
			await b.close();
			await s.close();
		}
	});
	it("binds tickets to principal, method and parameters, rejects tampering and consumes once", async () => {
		const s = setup();
		try {
			const params = {
				name: alias("a", "interactive"),
				arguments: { message: "one" },
			};
			const first = (await raw(s, params)).result;
			expect(first.resultType).toBe("input_required");
			const key = Object.keys(first.inputRequests)[0];
			const followup = {
				...params,
				requestState: first.requestState,
				inputResponses: { [key]: { roots: [{ uri: "file:///safe" }] } },
			};
			for (const [p, r, method] of [
				[followup, { sessionKey: "another-agent" }, "tools/call"],
				[{ ...followup, arguments: { message: "other" } }, {}, "tools/call"],
				[followup, {}, "prompts/get"],
				[
					{ ...followup, requestState: `${first.requestState}x` },
					{},
					"tools/call",
				],
			] as const)
				expect((await raw(s, p, r, method)).error.code).toBe(-32602);
			expect(s.gateway.pendingContinuations).toBe(1);
			const second = (await raw(s, followup)).result;
			expect(second.resultType).toBe("input_required");
			expect((await raw(s, followup)).error.code).toBe(-32602);
			const answer = Object.fromEntries(
				Object.entries(second.inputRequests).map(([key, req]) => [
					key,
					(req as { method: string }).method === "elicitation/create"
						? { action: "decline" }
						: {
								role: "assistant",
								model: "local",
								content: { type: "text", text: "done" },
							},
				]),
			);
			const final = await raw(s, {
				...params,
				requestState: second.requestState,
				inputResponses: answer,
			});
			expect(final.error).toBeUndefined();
			expect(JSON.stringify(final.result)).toContain("file:///safe");
			expect(s.gateway.pendingContinuations).toBe(0);
			if ("starts" in s.fixture) expect(s.fixture.starts()).toBe(1);
		} finally {
			await s.close();
		}
	});
	for (const change of ["block", "account", "revoke"] as const)
		it(`withholds an answer after ${change}`, async () => {
			const s = setup();
			try {
				const params = { name: alias("a", "interactive"), arguments: {} };
				const first = (await raw(s, params)).result;
				const key = Object.keys(first.inputRequests)[0];
				if (change === "block") s.rules.block.tools.push("interactive");
				else if (change === "account") s.changeIdentity();
				else await s.gateway.revoke("owner:agent");
				const next = await raw(s, {
					...params,
					requestState: first.requestState,
					inputResponses: { [key]: { roots: [{ uri: "file:///withhold" }] } },
				});
				expect(next.error).toBeTruthy();
				expect(s.fixture.seen).toEqual([]);
				expect(s.gateway.pendingContinuations).toBe(0);
			} finally {
				await s.close();
			}
		});
	it("re-asks for missing answers, ignores unknown ones and rejects malformed known answers", async () => {
		const s = setup();
		try {
			const params = { name: alias("a", "interactive"), arguments: {} };
			const first = (await raw(s, params)).result;
			const second = (
				await raw(s, {
					...params,
					requestState: first.requestState,
					inputResponses: { unknown: { roots: [] } },
				})
			).result;
			expect(second.inputRequests).toEqual(first.inputRequests);
			expect(second.requestState).not.toBe(first.requestState);
			const key = Object.keys(second.inputRequests)[0];
			const invalid = await raw(s, {
				...params,
				requestState: second.requestState,
				inputResponses: { [key]: { roots: "invalid" } },
			});
			expect(invalid.error.code).toBe(-32602);
			expect(s.fixture.seen).toEqual([]);
			expect(s.gateway.pendingContinuations).toBe(0);
			if ("starts" in s.fixture) expect(s.fixture.starts()).toBe(1);
		} finally {
			await s.close();
		}
	});
	it("consumes a continuation atomically when two answers race", async () => {
		const s = setup();
		try {
			const params = { name: alias("a", "interactive"), arguments: {} };
			const first = (await raw(s, params)).result;
			const key = Object.keys(first.inputRequests)[0];
			const retry = {
				...params,
				requestState: first.requestState,
				inputResponses: { [key]: { roots: [] } },
			};
			const answers = await Promise.all([raw(s, retry), raw(s, retry)]);
			expect(answers.filter((a) => a.error?.code === -32602)).toHaveLength(1);
			expect(
				answers.filter((a) => a.result?.resultType === "input_required"),
			).toHaveLength(1);
			expect(s.fixture.seen).toHaveLength(1);
		} finally {
			await s.close();
		}
	});
	it("bounds abandoned operations and expires them without replaying upstream work", async () => {
		const s = setup(true, { maxContinuations: 1, continuationMs: 40 });
		try {
			const params = { name: alias("a", "interactive"), arguments: {} };
			const first = (await raw(s, params)).result;
			expect((await raw(s, params)).error.message).toContain("capacity");
			await vi.waitFor(() => expect(s.gateway.pendingContinuations).toBe(0), {
				timeout: 500,
				interval: 10,
			});
			expect(
				(await raw(s, { ...params, requestState: first.requestState })).error
					.code,
			).toBe(-32602);
			expect(s.fixture.seen).toEqual([]);
			if ("starts" in s.fixture) expect(s.fixture.starts()).toBe(1);
		} finally {
			await s.close();
		}
	});
	it("cancels an active continuation before any answer reaches the source", async () => {
		const s = setup();
		const abort = new AbortController();
		let ready!: () => void, release!: () => void;
		const entered = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connections = s.runtime.connections;
		let hold = false;
		s.runtime.connections = async () => {
			if (hold) {
				ready();
				await waiting;
			}
			return connections();
		};
		try {
			const params = { name: alias("a", "interactive"), arguments: {} };
			const first = (await raw(s, params)).result;
			hold = true;
			const key = Object.keys(first.inputRequests)[0];
			const result = raw(
				s,
				{
					...params,
					requestState: first.requestState,
					inputResponses: { [key]: { roots: [{ uri: "file:///cancelled" }] } },
				},
				{},
				"tools/call",
				abort.signal,
			);
			await entered;
			abort.abort();
			release();
			const outcome = await result;
			expect(outcome.cancelled || outcome.error).toBeTruthy();
			expect(s.fixture.seen).toEqual([]);
			expect(s.gateway.pendingContinuations).toBe(0);
		} finally {
			release();
			await s.close();
		}
	});
	it("does not advertise unsupported agent extensions or request inputs from an incapable agent", async () => {
		const s = setup();
		const client = new Client(
			{ name: "without-input", version: "1" },
			{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
		);
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL("https://gateway/mcp"), {
					fetch: (input, init) =>
						s.gateway.handle(new Request(input, init), s.runtime),
				}),
			);
			expect(client.getServerCapabilities()).not.toHaveProperty(
				"subscriptions",
			);
			expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
			const result = client.callTool({
				name: alias("a", "interactive"),
				arguments: {},
			});
			await expect(result).rejects.toThrow();
			expect(s.gateway.pendingContinuations).toBe(0);
		} finally {
			await client.close();
			await s.close();
		}
	});
});
