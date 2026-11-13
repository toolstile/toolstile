import type { Rules, Snapshot } from "@toolstile/api/contract";
import { describe, expect, it } from "vitest";
import {
	accessSummary,
	capabilityRows,
	cellState,
	connectionAccess,
	connectionAccessLabel,
	countChanges,
	emptyRules,
	isEmptyRules,
	setApproval,
	setFull,
	toggleCell,
	toggleCells,
} from "./access-rules";

const rules = (patch: {
	full?: boolean;
	allow?: Partial<Rules["allow"]>;
	block?: Partial<Rules["block"]>;
}): Rules => ({
	full: patch.full ?? false,
	allow: { ...emptyRules().allow, ...patch.allow },
	block: { ...emptyRules().block, ...patch.block },
});

describe("access grid cells", () => {
	it("checks and unchecks a direct allow", () => {
		const checked = toggleCell(emptyRules(), "tools", "create_issue", true);
		expect(checked).toEqual(rules({ allow: { tools: ["create_issue"] } }));
		expect(cellState(checked, "tools", "create_issue")).toEqual({
			checked: true,
		});
		expect(toggleCell(checked, "tools", "create_issue", false)).toEqual(
			emptyRules(),
		);
	});

	it("blocks when an inherited cell is unchecked and unblocks when checked again", () => {
		const full = rules({ full: true });
		expect(cellState(full, "tools", "delete_repo")).toEqual({
			checked: true,
			inherited: "all",
		});
		const blocked = toggleCell(full, "tools", "delete_repo", false);
		expect(blocked).toEqual(
			rules({ full: true, block: { tools: ["delete_repo"] } }),
		);
		expect(cellState(blocked, "tools", "delete_repo")).toEqual({
			checked: false,
			blocked: "self",
		});
		// Still allowed by full, so no allow entry is added.
		expect(toggleCell(blocked, "tools", "delete_repo", true)).toEqual(full);
	});

	it("adds an allow when lifting a block leaves nothing else allowing it", () => {
		const blocked = rules({ block: { tools: ["push"] } });
		expect(toggleCell(blocked, "tools", "push", true)).toEqual(
			rules({ allow: { tools: ["push"] } }),
		);
	});

	it("removes a direct allow and blocks when it is also inherited", () => {
		const both = rules({ full: true, allow: { prompts: ["review"] } });
		expect(toggleCell(both, "prompts", "review", false)).toEqual(
			rules({ full: true, block: { prompts: ["review"] } }),
		);
	});

	it("turns full on and off without touching names", () => {
		const own = rules({
			allow: { tools: ["read"] },
			block: { tools: ["write"] },
		});
		const on = setFull(own, true);
		expect(on).toEqual({ ...own, full: true });
		expect(cellState(on, "tools", "other")).toEqual({
			checked: true,
			inherited: "all",
		});
		expect(cellState(on, "tools", "write").blocked).toBe("self");
		expect(setFull(on, false)).toEqual(own);
		expect(countChanges(own, on)).toBe(1);
	});

	it("preserves resource URI templates and other names it does not edit", () => {
		const template = "docs://project/{path}{?revision}";
		const own = rules({
			allow: { resources: [template], tools: ["a"] },
			block: { resources: ["docs://secret/{path}"] },
		});
		const next = toggleCell(own, "resources", "file:///readme.md", true);
		expect(next.allow.resources).toEqual([template, "file:///readme.md"]);
		expect(next.block.resources).toEqual(["docs://secret/{path}"]);
		expect(next.allow.tools).toEqual(["a"]);
		// Unchecking the template row itself removes only that entry.
		expect(
			toggleCell(next, "resources", template, false).allow.resources,
		).toEqual(["file:///readme.md"]);
	});

	it("does not mutate its input", () => {
		const own = rules({ allow: { tools: ["a"] } });
		const snapshot = structuredClone(own);
		toggleCell(own, "tools", "a", false);
		toggleCell(own, "tools", "b", true);
		setFull(own, true);
		expect(own).toEqual(snapshot);
	});
});

describe("Everyone interplay", () => {
	it("shows Everyone allows and full as inherited on agent columns", () => {
		const everyone = rules({ allow: { tools: ["search"] } });
		expect(cellState(emptyRules(), "tools", "search", everyone)).toEqual({
			checked: true,
			inherited: "everyone",
		});
		expect(
			cellState(emptyRules(), "tools", "x", rules({ full: true })),
		).toEqual({ checked: true, inherited: "everyone-all" });
	});

	it("blocks one agent from an Everyone allow without changing Everyone", () => {
		const everyone = rules({ allow: { tools: ["search"] } });
		const own = toggleCell(emptyRules(), "tools", "search", false, everyone);
		expect(own).toEqual(rules({ block: { tools: ["search"] } }));
		expect(cellState(own, "tools", "search", everyone).blocked).toBe("self");
		// Checking again just removes the agent's block.
		expect(toggleCell(own, "tools", "search", true, everyone)).toEqual(
			emptyRules(),
		);
	});

	it("cannot lift an Everyone block from an agent column", () => {
		const everyone = rules({ full: true, block: { tools: ["drop"] } });
		const own = rules({ allow: { tools: ["drop"] } });
		expect(cellState(own, "tools", "drop", everyone)).toEqual({
			checked: false,
			blocked: "everyone",
		});
		expect(toggleCell(own, "tools", "drop", true, everyone)).toBe(own);
	});

	it("prefers the agent's own entries over Everyone for the source", () => {
		const everyone = rules({ full: true });
		expect(
			cellState(rules({ allow: { tools: ["a"] } }), "tools", "a", everyone),
		).toEqual({ checked: true });
		expect(cellState(rules({ full: true }), "tools", "a", everyone)).toEqual({
			checked: true,
			inherited: "all",
		});
	});
});

describe("bulk changes and counts", () => {
	it("applies a column-wide select all and none", () => {
		const all = toggleCells(emptyRules(), "tools", ["a", "b", "c"], true);
		expect(all.allow.tools).toEqual(["a", "b", "c"]);
		expect(countChanges(emptyRules(), all)).toBe(3);
		const none = toggleCells(all, "tools", ["a", "b"], false);
		expect(none).toEqual(rules({ allow: { tools: ["c"] } }));
	});

	it("counts a blocked cell that becomes allowed once", () => {
		const saved = rules({ block: { tools: ["push"] } });
		expect(countChanges(saved, toggleCell(saved, "tools", "push", true))).toBe(
			1,
		);
		expect(isEmptyRules(toggleCell(saved, "tools", "push", true))).toBe(false);
		expect(isEmptyRules(emptyRules())).toBe(true);
	});
});

describe("rows and summaries", () => {
	it("lists catalog rows, then saved names no longer offered, then added names", () => {
		const rows = capabilityRows(
			"tools",
			{ names: ["a", "b"], descriptions: new Map([["a", "Reads"]]) },
			[rules({ allow: { tools: ["gone", "a"] }, block: { tools: ["old"] } })],
			["typed", "b"],
		);
		expect(rows).toEqual([
			{ name: "a", description: "Reads", offered: true },
			{ name: "b", description: undefined, offered: true },
			{ name: "gone", offered: false },
			{ name: "old", offered: false },
			{ name: "typed", offered: false },
		]);
		expect(
			capabilityRows("tools", undefined, [rules({ allow: { tools: ["x"] } })]),
		).toEqual([{ name: "x", offered: undefined }]);
	});

	it("summarises effective access", () => {
		expect(accessSummary([emptyRules()])).toBeNull();
		expect(accessSummary([rules({ full: true })])).toBe("full access");
		expect(
			accessSummary([rules({ full: true, block: { tools: ["x", "y"] } })]),
		).toBe("full access, 2 blocked");
		expect(
			accessSummary([
				rules({ allow: { tools: ["a", "b", "c"], prompts: ["p"] } }),
				rules({ allow: { tools: ["a"] }, block: { tools: ["c"] } }),
			]),
		).toBe("2 tools, 1 prompt");
	});
});

describe("connection access counts", () => {
	const rules = (overrides: Partial<Rules> = {}): Rules => ({
		...emptyRules(),
		...overrides,
	});
	const agent = (id: string, overrides = {}) => ({
		id,
		canTest: true,
		label: id,
		deviceId: "d1",
		revoked: false,
		expiresAt: null,
		...overrides,
	});
	const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
		user: { name: "Fixture", email: "fixture@example.test", operator: false },
		connections: [],
		devices: [
			{ id: "d1", label: "Laptop", revoked: false },
			{ id: "d2", label: "Old", revoked: true },
		],
		agents: [
			agent("full"),
			agent("listed"),
			agent("self-blocked"),
			agent("none"),
			agent("expired", { expiresAt: "2020-01-01T00:00:00.000Z" }),
			agent("revoked", { revoked: true }),
			agent("revoked-device", { deviceId: "d2" }),
		],
		grants: [
			{
				agentId: "full",
				connectionId: "c",
				rules: rules({
					full: true,
					block: { tools: ["delete"], resources: [], prompts: [] },
				}),
			},
			{
				agentId: "listed",
				connectionId: "c",
				rules: rules({
					allow: { tools: ["read"], resources: [], prompts: [] },
				}),
			},
			{
				agentId: "self-blocked",
				connectionId: "c",
				rules: rules({
					allow: { tools: ["read"], resources: [], prompts: [] },
					block: { tools: ["read"], resources: [], prompts: [] },
				}),
			},
			...["expired", "revoked", "revoked-device"].map((agentId) => ({
				agentId,
				connectionId: "c",
				rules: rules({ full: true }),
			})),
		],
		activity: [],
		allAgentGrants: [],
		...overrides,
	});
	const now = Date.parse("2026-10-23T00:00:00.000Z");

	it("counts only active agents whose own and all-agent rules still allow something", () => {
		const access = connectionAccess(snapshot(), "c", now);
		expect(access).toEqual({ agents: 2, active: 4, allAgentRule: false });
		expect(connectionAccessLabel(access)).toBe("2 agents have access");
		expect(connectionAccessLabel(access, true)).toBe("2 agents");
		expect(
			connectionAccessLabel(connectionAccess(snapshot(), "other", now)),
		).toBe("No agent access");
	});

	it("reports an all-agent rule separately from the agents it actually reaches", () => {
		// The rule allows only "read", and one agent blocks it with its own rules.
		const data = snapshot({
			agents: [agent("a"), agent("b"), agent("c")],
			grants: [
				{
					agentId: "a",
					connectionId: "c",
					rules: rules({
						block: { tools: ["read"], resources: [], prompts: [] },
					}),
				},
			],
			allAgentGrants: [
				{
					connectionId: "c",
					rules: rules({
						allow: { tools: ["read"], resources: [], prompts: [] },
					}),
				},
			],
		});
		const access = connectionAccess(data, "c", now);
		expect(access).toEqual({ agents: 2, active: 3, allAgentRule: true });
		expect(connectionAccessLabel(access)).toBe(
			"2 agents have access · All-agent rule",
		);
		expect(connectionAccessLabel(access, true)).toBe(
			"2 agents · All-agent rule",
		);
		const blockedEverywhere = connectionAccess(
			{
				...data,
				grants: ["a", "b", "c"].map((agentId) => ({
					agentId,
					connectionId: "c",
					rules: rules({
						block: { tools: ["read"], resources: [], prompts: [] },
					}),
				})),
			},
			"c",
			now,
		);
		expect(connectionAccessLabel(blockedEverywhere)).toBe(
			"No agent access · All-agent rule",
		);
	});
});

describe("approval-required tools", () => {
	const approval = (names: string[], base = emptyRules()): Rules => ({
		...base,
		requireApproval: names,
	});
	it("shows approval as a conditional grant; blocks still win", () => {
		expect(cellState(approval(["create"]), "tools", "create")).toEqual({
			checked: true,
			approval: "self",
		});
		expect(
			cellState(
				rules({ allow: { tools: ["create"] } }),
				"tools",
				"create",
				approval(["create"]),
			),
		).toEqual({ checked: true, approval: "everyone" });
		expect(
			cellState(
				{
					...approval(["create"]),
					block: { ...emptyRules().block, tools: ["create"] },
				},
				"tools",
				"create",
			),
		).toEqual({ checked: false, blocked: "self" });
	});
	it("sets and clears approval without dropping other entries", () => {
		const allowed = rules({ allow: { tools: ["create", "search"] } });
		const gated = setApproval(allowed, "create", true);
		expect(gated.allow.tools).toEqual(["search"]);
		expect(gated.requireApproval).toEqual(["create"]);
		const immediate = setApproval(gated, "create", false);
		expect(immediate.allow.tools).toEqual(["search", "create"]);
		expect(immediate).not.toHaveProperty("requireApproval");
		// An Everyone approval cannot be lifted from an agent column.
		expect(setApproval(allowed, "create", false, approval(["create"]))).toBe(
			allowed,
		);
	});
	it("preserves approval through toggles, counts and summaries", () => {
		const gated = approval(["create"], rules({ allow: { tools: ["search"] } }));
		expect(toggleCell(gated, "tools", "search", false).requireApproval).toEqual(
			["create"],
		);
		expect(toggleCell(gated, "tools", "create", false)).toMatchObject({
			allow: { tools: ["search"] },
		});
		expect(toggleCell(gated, "tools", "create", false)).not.toHaveProperty(
			"requireApproval",
		);
		expect(countChanges(rules({ allow: { tools: ["search"] } }), gated)).toBe(
			1,
		);
		expect(isEmptyRules(approval(["create"]))).toBe(false);
		expect(accessSummary([gated])).toBe("1 tool, 1 needs approval");
		expect(accessSummary([{ ...gated, full: true }])).toBe(
			"full access, 1 needs approval",
		);
		expect(
			capabilityRows("tools", undefined, [gated]).map((row) => row.name),
		).toEqual(["search", "create"]);
	});
});
