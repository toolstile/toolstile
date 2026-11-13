import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
	type ApprovalBegin,
	type ApprovalRequest,
	ApprovalRequiredError,
	alias,
	approvalRequest,
	canonicalJson,
	emptyRules,
	handleMcp,
	invoke,
	type Operation,
	openUpstream,
	type Rules,
	type Runtime,
	testAgentTool,
	toolDecision,
	type Upstream,
} from "../packages/gateway/src/index";
import { defined } from "./assertions";

type Row = {
	id: string;
	binding: string;
	status: string;
	operationId?: string;
};
/** In-memory model of the store lifecycle; the PostgreSQL store has its own tests. */
function memoryApprovals() {
	const rows: Row[] = [];
	const requests: ApprovalRequest[] = [];
	const events: string[] = [];
	const expiresAt = new Date(Date.now() + 60_000);
	return {
		rows,
		requests,
		events,
		approve() {
			for (const row of rows)
				if (row.status === "pending") row.status = "approved";
		},
		approvals: {
			async begin(request, operationId): Promise<ApprovalBegin> {
				requests.push(request);
				const row = rows.find(
					(entry) =>
						entry.binding === request.binding &&
						["pending", "approved", "claimed", "denied"].includes(entry.status),
				);
				if (row?.status === "approved") {
					row.status = "claimed";
					row.operationId = operationId;
					events.push("claim");
					return { kind: "permit", id: row.id };
				}
				if (row)
					return {
						kind:
							row.status === "claimed"
								? "busy"
								: (row.status as "pending" | "denied"),
						id: row.id,
						expiresAt,
					};
				const id = `request-${rows.length + 1}`;
				rows.push({ id, binding: request.binding, status: "pending" });
				return {
					kind: "pending",
					id,
					expiresAt,
					reviewUrl: `/app/approvals/${id}`,
				};
			},
			async release(id, operationId) {
				const row = rows.find((entry) => entry.id === id);
				if (row?.status === "claimed" && row.operationId === operationId)
					row.status = "approved";
				events.push("release");
			},
			async settle(id, operationId, outcome) {
				const row = rows.find((entry) => entry.id === id);
				events.push(outcome);
				if (row?.status === "claimed" && row.operationId === operationId)
					row.status = outcome;
				else if (
					outcome === "consumed" &&
					!(row?.status === "consumed" && row.operationId === operationId)
				)
					throw new Error("Approval claim lost");
			},
		} satisfies NonNullable<Runtime["approvals"]>,
	};
}

function fixture(
	options: {
		rules?: Rules[];
		modern?: boolean;
		continuation?: boolean;
		approvals?: boolean;
	} = {},
) {
	const calls: unknown[] = [];
	const wire: Record<string, unknown>[] = [];
	const handler = createMcpHandler(
		() => {
			const server = new Server(
				{ name: "approval", version: "1" },
				{ capabilities: { tools: {} } },
			);
			server.setRequestHandler("tools/list", async () => ({
				tools: [
					{ name: "search", inputSchema: { type: "object" } },
					{ name: "create_issue", inputSchema: { type: "object" } },
				],
			}));
			server.setRequestHandler("tools/call", async (request) => {
				calls.push(request.params);
				return { content: [{ type: "text", text: "private result" }] };
			});
			return server;
		},
		{ legacy: options.modern ? "reject" : "stateless" },
	);
	const source: Upstream = {
		id: "11111111-1111-1111-1111-111111111111",
		label: "Tracker",
		url: "https://fixture/mcp",
		transport: "http",
		headers: {},
		identityKey: "grant-1",
		rules: options.rules ?? [
			{
				...emptyRules(),
				allow: { tools: ["search"], resources: [], prompts: [] },
				requireApproval: ["create_issue"],
			},
		],
	};
	const memory = memoryApprovals();
	const admitted: Operation[] = [];
	const recorded: { operation: Operation; outcome: string }[] = [];
	const captured: Operation[] = [];
	let refuseAdmission = false;
	let consumeOnAdmit = false;
	let afterAdmit: (() => void) | undefined;
	const runtime: Runtime = {
		connections: async () => [source],
		validateDestination: async () => {},
		capture: async (operation) => {
			captured.push(operation);
			return async () => {};
		},
		admit: async (operation) => {
			if (refuseAdmission && operation.method === "tools/call")
				throw new Error("quota");
			admitted.push(operation);
			// A host may consume the exact claim inside its admission transaction.
			if (consumeOnAdmit && operation.approval) {
				const row = memory.rows.find(
					(entry) => entry.id === operation.approval?.id,
				);
				if (
					row?.status !== "claimed" ||
					row.operationId !== operation.approval.operationId
				)
					throw new Error("Approval claim lost");
				row.status = "consumed";
			}
			afterAdmit?.();
		},
		record: async (operation, outcome) => {
			recorded.push({ operation, outcome });
		},
		...(options.approvals === false ? {} : { approvals: memory.approvals }),
		fetch: async (input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (body.method === "tools/call") {
				wire.push(body.params);
				if (options.continuation && !body.params.requestState)
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { resultType: "input_required", requestState: "opaque" },
					});
			}
			if (!options.modern && body.method === "server/discover")
				return new Response(null, { status: 404 });
			return handler.fetch(new Request(input, init));
		},
	};
	return {
		source,
		runtime,
		memory,
		calls,
		wire,
		admitted,
		recorded,
		captured,
		refuse(value: boolean) {
			refuseAdmission = value;
		},
		consumeOnAdmit() {
			consumeOnAdmit = true;
		},
		afterAdmit(work: () => void) {
			afterAdmit = work;
		},
	};
}
const call = (
	f: ReturnType<typeof fixture>,
	args: Record<string, unknown> = { title: "Bug" },
	name = "create_issue",
) =>
	invoke(f.runtime, f.source, "tools/call", name, (client) =>
		client.callTool({ name, arguments: args }),
	);
const toolCalls = <T extends { method: string }>(operations: T[]) =>
	operations.filter((operation) => operation.method === "tools/call");

describe("tool decisions", () => {
	const base = emptyRules();
	it("blocks beat approval and approval beats allow, across sources", () => {
		expect(
			toolDecision(
				[
					{ ...base, requireApproval: ["x"] },
					{ ...base, block: { ...base.block, tools: ["x"] } },
				],
				"x",
			),
		).toBe("deny");
		expect(
			toolDecision(
				[
					{ ...base, allow: { ...base.allow, tools: ["x"] } },
					{ ...base, requireApproval: ["x"] },
				],
				"x",
			),
		).toBe("approval");
		expect(
			toolDecision([{ ...base, full: true, requireApproval: ["x"] }], "x"),
		).toBe("approval");
		expect(toolDecision([{ ...base, full: true }], "x")).toBe("allow");
		expect(toolDecision([{ ...base, requireApproval: ["x"] }], "y")).toBe(
			"deny",
		);
	});
	it("binds account, rules and exact parameters canonically", () => {
		const f = fixture();
		const one = approvalRequest(f.source, {
			name: "create_issue",
			arguments: { b: 1, a: { d: [1, 2], c: null } },
		});
		const reordered = approvalRequest(f.source, {
			name: "create_issue",
			arguments: { a: { c: null, d: [1, 2] }, b: 1 },
		});
		expect(reordered.binding).toBe(one.binding);
		expect(
			approvalRequest(f.source, { name: "create_issue", arguments: { b: 2 } })
				.binding,
		).not.toBe(one.binding);
		expect(
			approvalRequest(
				{ ...f.source, identityKey: "grant-2" },
				{
					name: "create_issue",
					arguments: { b: 1, a: { d: [1, 2], c: null } },
				},
			).binding,
		).not.toBe(one.binding);
		expect(
			approvalRequest(
				{
					...f.source,
					rules: [{ ...emptyRules(), requireApproval: ["create_issue"] }],
				},
				{
					name: "create_issue",
					arguments: { b: 1, a: { d: [1, 2], c: null } },
				},
			).binding,
		).not.toBe(one.binding);
	});
	it("refuses oversized or deeply nested parameters instead of truncating", () => {
		expect(() => canonicalJson({ text: "x".repeat(70_000) })).toThrow(
			/too large/,
		);
		let nested: unknown = 1;
		for (let depth = 0; depth < 40; depth++) nested = [nested];
		expect(() => canonicalJson(nested)).toThrow(/nested/);
		expect(() => canonicalJson({ value: Number.NaN })).toThrow(/JSON/);
	});
});

for (const modern of [false, true])
	describe(`${modern ? "modern" : "legacy"} approval gate`, () => {
		it("returns approval-required without forwarding, admitting or capturing", async () => {
			const f = fixture({ modern });
			const error = await call(f).catch((reason) => reason);
			expect(error).toBeInstanceOf(ApprovalRequiredError);
			expect(error.approval).toMatchObject({
				id: "request-1",
				status: "pending",
			});
			expect(f.calls).toEqual([]);
			expect(toolCalls(f.admitted)).toEqual([]);
			expect(f.captured).toEqual([]);
			expect(f.recorded.map((entry) => entry.outcome)).toEqual([
				"approval_required",
			]);
			expect(JSON.stringify(f.recorded)).not.toContain("Bug");
			// A retry before review finds the same pending request.
			await expect(call(f)).rejects.toMatchObject({
				approval: { id: "request-1" },
			});
			expect(f.memory.rows).toHaveLength(1);
		});

		it("forwards an approved identical retry exactly once", async () => {
			const f = fixture({ modern });
			await call(f).catch(() => {});
			f.memory.approve();
			const result = await call(f, { title: "Bug" });
			expect(result.content).toEqual([
				{ type: "text", text: "private result" },
			]);
			expect(f.calls).toEqual([
				expect.objectContaining({
					name: "create_issue",
					arguments: { title: "Bug" },
				}),
			]);
			expect(f.memory.rows[0].status).toBe("consumed");
			expect(toolCalls(f.admitted)).toHaveLength(1);
			// The permit is single-use: another identical call needs a new approval.
			await expect(call(f)).rejects.toMatchObject({
				approval: { id: "request-2", status: "pending" },
			});
			expect(f.calls).toHaveLength(1);
		});

		it("never applies an approval to different arguments", async () => {
			const f = fixture({ modern });
			await call(f).catch(() => {});
			f.memory.approve();
			await expect(call(f, { title: "Other" })).rejects.toBeInstanceOf(
				ApprovalRequiredError,
			);
			expect(f.calls).toEqual([]);
			expect(f.memory.rows.map((row) => row.status)).toEqual([
				"approved",
				"pending",
			]);
		});

		it("returns the approval when admission refuses before forwarding", async () => {
			const f = fixture({ modern });
			await call(f).catch(() => {});
			f.memory.approve();
			f.refuse(true);
			await expect(call(f)).rejects.toThrow();
			expect(f.calls).toEqual([]);
			expect(f.memory.rows[0].status).toBe("approved");
			expect(f.memory.events).toEqual(["claim", "release"]);
			f.refuse(false);
			await call(f);
			expect(f.calls).toHaveLength(1);
		});

		it("fails closed without a runtime approval store", async () => {
			const f = fixture({ modern, approvals: false });
			await expect(call(f)).rejects.toThrow(/access denied/);
			expect(f.calls).toEqual([]);
			expect(f.recorded.map((entry) => entry.outcome)).toEqual(["denied"]);
		});

		it("refuses unreviewed metadata and calls on clients not opened for them", async () => {
			const f = fixture({ modern });
			await expect(
				invoke(f.runtime, f.source, "tools/call", "create_issue", (client) =>
					client.callTool({
						name: "create_issue",
						arguments: { title: "Bug" },
						_meta: { "vendor/extra": "x" },
					}),
				),
			).rejects.toThrow(/metadata/);
			const other = await openUpstream(
				f.runtime,
				f.source,
				"maintenance",
				undefined,
			);
			try {
				await expect(
					other.callTool({ name: "create_issue", arguments: {} }),
				).rejects.toThrow(/opened for that exact call/);
			} finally {
				await other.close();
			}
			expect(f.calls).toEqual([]);
			expect(f.memory.rows).toEqual([]);
		});

		it("refuses a raw wire call that bypasses the request precheck", async () => {
			const f = fixture({ modern });
			const client = await openUpstream(
				f.runtime,
				f.source,
				"tools/call",
				"create_issue",
			);
			try {
				const transport = defined(client.transport);
				await expect(
					transport.send({
						jsonrpc: "2.0",
						id: 99,
						method: "tools/call",
						params: { name: "create_issue", arguments: { title: "Bug" } },
					}),
				).rejects.toThrow(/must go through approval/);
			} finally {
				await client.close();
			}
			expect(f.calls).toEqual([]);
			expect(f.wire).toEqual([]);
		});

		it("never forwards when the claim was lost before dispatch", async () => {
			const f = fixture({ modern });
			await call(f).catch(() => {});
			f.memory.approve();
			// Expiry or cleanup invalidates the claimed row between admission and dispatch.
			f.afterAdmit(() => {
				for (const row of f.memory.rows) row.status = "invalidated";
			});
			await expect(call(f)).rejects.toThrow(/claim lost/);
			expect(f.calls).toEqual([]);
			expect(f.wire).toEqual([]);
			expect(f.recorded.at(-1)?.outcome).toBe("denied");
		});

		it("passes the permit to admission and tolerates consumption there", async () => {
			const f = fixture({ modern });
			f.consumeOnAdmit();
			await call(f).catch(() => {});
			f.memory.approve();
			await call(f);
			const [admitted] = toolCalls(f.admitted);
			expect(admitted.approval).toEqual({
				id: "request-1",
				operationId: expect.any(String),
			});
			expect(JSON.stringify(admitted)).not.toContain("Bug");
			expect(f.calls).toHaveLength(1);
			expect(f.memory.rows[0].status).toBe("consumed");
		});

		it("rejects request methods sent as notifications", async () => {
			const f = fixture({ modern });
			const client = await openUpstream(
				f.runtime,
				f.source,
				"tools/call",
				"search",
			);
			try {
				await expect(
					defined(client.transport).send({
						jsonrpc: "2.0",
						method: "tools/call",
						params: { name: "create_issue", arguments: { title: "Bug" } },
					}),
				).rejects.toThrow(/Unsupported upstream notification/);
			} finally {
				await client.close();
			}
			expect(f.calls).toEqual([]);
			expect(f.wire).toEqual([]);
		});

		it("runs immediately-allowed tools unchanged", async () => {
			const f = fixture({ modern });
			await call(f, { query: "x" }, "search");
			expect(f.calls).toHaveLength(1);
			expect(f.memory.requests).toEqual([]);
		});

		it("gates dashboard tests the same way", async () => {
			const f = fixture({ modern });
			const pending = await testAgentTool(f.runtime, f.source, "create_issue", {
				title: "Bug",
			});
			expect(pending).toMatchObject({
				isError: true,
				preview: "",
				approval: {
					id: "request-1",
					status: "pending",
					reviewUrl: "/app/approvals/request-1",
				},
			});
			expect(f.calls).toEqual([]);
			f.memory.approve();
			const ran = await testAgentTool(f.runtime, f.source, "create_issue", {
				title: "Bug",
			});
			expect(ran.isError).toBe(false);
			expect(f.calls).toHaveLength(1);
		});
	});

describe("approved calls cannot take unreviewed continuation input", () => {
	it("fails closed on a requestState follow-up after the reviewed leg", async () => {
		const f = fixture({ modern: true, continuation: true });
		await call(f).catch(() => {});
		f.memory.approve();
		await expect(call(f)).rejects.toThrow();
		// Only the reviewed first leg left the gateway; the continuation never did.
		expect(f.wire).toHaveLength(1);
		expect(f.wire[0]).not.toHaveProperty("requestState");
		expect(f.memory.rows[0].status).toBe("consumed");
	});
});

describe("MCP handler", () => {
	it.each([false, true])(
		"lists gated tools and runs one reviewed retry (approval-only grant: %s)",
		async (approvalOnly) => {
			const f = fixture(
				approvalOnly
					? { rules: [{ ...emptyRules(), requireApproval: ["create_issue"] }] }
					: {},
			);
			const agent = new Client({ name: "agent", version: "1" });
			await agent.connect(
				new StreamableHTTPClientTransport(new URL("http://gateway/mcp"), {
					fetch: async (input, init) =>
						handleMcp(
							new Request(
								input instanceof Request ? input.url : String(input),
								init,
							),
							f.runtime,
						),
				}),
			);
			try {
				const name = alias(f.source.id, "create_issue");
				const listed = await agent.listTools();
				expect(listed.tools.map((tool) => tool.name)).toContain(name);
				const pending = await agent.callTool({
					name,
					arguments: { title: "Bug" },
					_meta: { "client/trace": "unreviewed" },
				});
				expect(pending.isError).toBe(true);
				expect(pending._meta?.["toolstile/approval"]).toMatchObject({
					id: "request-1",
					status: "pending",
				});
				expect(JSON.stringify(pending)).not.toContain("Bug");
				expect(f.calls).toEqual([]);
				f.memory.approve();
				const ran = await agent.callTool({
					name,
					arguments: { title: "Bug" },
					_meta: { "client/trace": "different" },
				});
				expect(ran.isError).toBeFalsy();
				expect(f.calls).toHaveLength(1);
				// Requester metadata is not forwarded for a gated call.
				expect(JSON.stringify(f.wire)).not.toContain("client/trace");
			} finally {
				await agent.close();
			}
		},
	);
});
