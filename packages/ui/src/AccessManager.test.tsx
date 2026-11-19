import type { Rules, Snapshot } from "@toolstile/api/contract";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@stylexjs/stylex", () => ({
	create: <T,>(value: T) => value,
	defineVars: <T,>(value: T) => value,
	keyframes: () => "",
	defaultMarker: () => ({}),
	when: { ancestor: () => ":hover" },
	props: () => ({}),
}));

import {
	AccessManager,
	addNameProblem,
	applyStarter,
	type CatalogState,
	catalogProblem,
	StarterStrip,
	setToolMode,
	toolCell,
	unsavedRowNames,
} from "./AccessManager";
import { emptyRules, setFull } from "./access-rules";

const rules = (patch: Partial<Rules> = {}): Rules => ({
	...emptyRules(),
	...patch,
});
const tools = (list: string[]) => ({ ...emptyRules().allow, tools: list });

describe("per-tool modes", () => {
	it("gives each tool exactly one own mode and keeps other entries", () => {
		const base = rules({
			allow: tools(["read", "send"]),
			block: { ...emptyRules().block, prompts: ["p"] },
		});
		const approval = setToolMode(base, "send", "approval");
		expect(approval.allow.tools).toEqual(["read"]);
		expect(approval.requireApproval).toEqual(["send"]);
		expect(approval.block.prompts).toEqual(["p"]);
		expect(toolCell(approval, "send")).toEqual({
			effect: "approval",
			own: "approval",
		});
		const blocked = setToolMode(approval, "send", "block");
		expect(blocked.requireApproval).toBeUndefined();
		expect(blocked.block.tools).toEqual(["send"]);
		const cleared = setToolMode(blocked, "send", "default");
		expect(cleared).toEqual(
			rules({ allow: tools(["read"]), block: base.block }),
		);
	});

	it("applies Block over Require approval over Allow and full access", () => {
		const own = rules({
			full: true,
			allow: tools(["send"]),
			requireApproval: ["send"],
		});
		expect(toolCell(own, "send").effect).toBe("approval");
		expect(toolCell(own, "other")).toEqual({
			effect: "allowed",
			inherited: "all",
		});
		expect(
			toolCell({ ...own, block: { ...own.block, tools: ["send"] } }, "send")
				.effect,
		).toBe("blocked");
	});

	it("keeps approval exceptions when full access is toggled", () => {
		const own = setToolMode(rules(), "send", "approval");
		expect(setFull(setFull(own, true), false).requireApproval).toEqual([
			"send",
		]);
		expect(toolCell(setFull(own, true), "send").effect).toBe("approval");
	});

	it("never lets an agent column lift an Everyone block or approval", () => {
		const everyone = rules({
			requireApproval: ["send"],
			block: { ...emptyRules().block, tools: ["drop"] },
		});
		const own = rules({ full: true });
		expect(toolCell(own, "send", everyone)).toMatchObject({
			effect: "approval",
			everyoneLock: "approval",
		});
		expect(setToolMode(own, "send", "allow", everyone)).toBe(own);
		expect(setToolMode(own, "drop", "approval", everyone)).toBe(own);
		// An agent may still make an inherited approval stricter.
		expect(
			toolCell(setToolMode(own, "send", "block", everyone), "send", everyone)
				.effect,
		).toBe("blocked");
	});
});

describe("access grid tool cells", () => {
	const data: Snapshot = {
		user: { name: "Test", email: "test@example.test", operator: false },
		connections: [
			{
				id: "c1",
				label: "Mail",
				url: "https://mail.example.test/mcp",
				transport: "http",
				status: "reachable",
				authentication: "headers",
				canManageAuthentication: true,
			},
		],
		devices: [{ id: "d1", label: "Laptop", revoked: false }],
		agents: [
			{
				id: "a1",
				label: "Writer",
				deviceId: "d1",
				revoked: false,
				expiresAt: null,
				canTest: true,
			},
		],
		grants: [
			{
				agentId: "a1",
				connectionId: "c1",
				rules: rules({ allow: tools(["read"]), requireApproval: ["send"] }),
			},
		],
		activity: [],
		allAgentGrants: [],
	};
	const ready: CatalogState = {
		status: "ready",
		data: { tools: ["read", "send", "drop"], resources: [], prompts: [] },
		checkedAt: "2026-10-23T00:00:00.000Z",
	};
	const render = (catalog: CatalogState = ready, snapshot = data) =>
		renderToStaticMarkup(
			<AccessManager
				data={snapshot}
				api={{} as never}
				view={{ server: "c1" }}
				onViewChange={() => undefined}
				catalogs={{ c1: catalog }}
				loadCatalog={() => undefined}
				busy={false}
				save={async () => true}
				reload={async () => undefined}
				renderLink={({ children }) => children}
				onDirtyChange={() => undefined}
				onSignIn={() => undefined}
				onConnectAgent={() => undefined}
				connectionAccessSummary={() => ""}
			/>,
		);
	it("labels each tool cell with its effective mode", () => {
		const html = render();
		expect(html).toContain('aria-label="read for Writer on Laptop: Allowed"');
		expect(html).toContain(
			'aria-label="send for Writer on Laptop: Requires approval"',
		);
		expect(html).toContain(
			'aria-label="drop for Writer on Laptop: Not allowed"',
		);
		expect(html).toContain('aria-haspopup="menu"');
	});

	it("names the full-access checkbox with its visible text and its scope", () => {
		expect(render()).toContain(
			'aria-label="Everything, including ones added later: allow every tool, resource and prompt on Mail for Writer on Laptop"',
		);
	});

	it("explains blocks only under “Everything” when a rule set blocks something", () => {
		expect(render()).not.toContain("stays blocked");
		expect(render()).not.toContain("Nothing changes until you save");
		const blocked = (full: boolean): Snapshot => ({
			...data,
			grants: [
				{
					agentId: "a1",
					connectionId: "c1",
					rules: rules({
						full,
						block: { ...emptyRules().block, tools: ["drop"] },
					}),
				},
			],
		});
		// Without “Everything” the blocked row's own mode says it; the rule only matters under it.
		expect(render(ready, blocked(false))).not.toContain("stays blocked");
		expect(render(ready, blocked(true))).toContain(
			"A blocked tool stays blocked, even under “Everything”.",
		);
	});

	const noAccess: Snapshot = { ...data, grants: [] };
	it("offers a first grant only to an agent that reaches nothing saved", () => {
		const html = render(ready, noAccess);
		expect(html).toContain("Writer can’t use Mail yet.");
		expect(html).toContain(
			"Allow its 3 tools now, or choose tool by tool below. Tools Mail adds later stay off until you allow them.",
		);
		expect(html).toContain("Allow all 3 Mail tools for Writer</button>");
		expect(html).toContain('aria-label="Access for Writer on Mail"');
		// Writer already reaches tools here.
		expect(render()).not.toContain("can’t use Mail yet");
		// One tool reads in the singular.
		expect(
			render({ ...ready, data: { ...ready.data, tools: ["read"] } }, noAccess),
		).toContain("Allow the 1 Mail tool for Writer</button>");
		// Access inherited from Everyone counts as access.
		const inherited = renderToStaticMarkup(
			<AccessManager
				data={{
					...noAccess,
					allAgentGrants: [
						{ connectionId: "c1", rules: rules({ allow: tools(["read"]) }) },
					],
				}}
				api={{} as never}
				everyone={{} as never}
				view={{ server: "c1", agent: "a1" }}
				onViewChange={() => undefined}
				catalogs={{ c1: ready }}
				loadCatalog={() => undefined}
				busy={false}
				save={async () => true}
				reload={async () => undefined}
				renderLink={({ children }) => children}
				onDirtyChange={() => undefined}
				onSignIn={() => undefined}
				onConnectAgent={() => undefined}
				connectionAccessSummary={() => ""}
			/>,
		);
		expect(inherited).not.toContain("can’t use Mail yet");
		expect(inherited).toContain("Unset tools follow Everyone.");
	});

	const withEveryone = (everyoneRules: Rules, own?: Rules) =>
		renderToStaticMarkup(
			<AccessManager
				data={{
					...noAccess,
					grants: own
						? [{ agentId: "a1", connectionId: "c1", rules: own }]
						: [],
					allAgentGrants: [{ connectionId: "c1", rules: everyoneRules }],
				}}
				api={{} as never}
				everyone={{} as never}
				view={{ server: "c1", agent: "a1" }}
				onViewChange={() => undefined}
				catalogs={{ c1: ready }}
				loadCatalog={() => undefined}
				busy={false}
				save={async () => true}
				reload={async () => undefined}
				renderLink={({ children }) => children}
				onDirtyChange={() => undefined}
				onSignIn={() => undefined}
				onConnectAgent={() => undefined}
				connectionAccessSummary={() => ""}
			/>,
		);
	it("offers only the tools Everyone does not block, and none when all are blocked", () => {
		const some = withEveryone(
			rules({ block: { tools: ["drop"], resources: [], prompts: [] } }),
		);
		expect(some).toContain("Allow all 2 Mail tools for Writer</button>");
		expect(some).toContain("1 set under Everyone stays as set there.");
		const all = withEveryone(
			rules({
				block: { tools: ["read", "send", "drop"], resources: [], prompts: [] },
			}),
		);
		expect(all).toContain("Every tool here is set under Everyone.");
		expect(all).not.toContain("Mail tools for Writer</button>");
	});

	it("does not call saved resource access no access", () => {
		expect(
			withEveryone(
				rules({}),
				rules({
					allow: { tools: [], resources: ["file:///a"], prompts: [] },
				}),
			),
		).not.toContain("can’t use Mail yet");
	});

	it("never offers the first grant to Everyone or under a filter", () => {
		const everyoneView = renderToStaticMarkup(
			<AccessManager
				data={noAccess}
				api={{} as never}
				everyone={{} as never}
				view={{ server: "c1", agent: "everyone" }}
				onViewChange={() => undefined}
				catalogs={{ c1: ready }}
				loadCatalog={() => undefined}
				busy={false}
				save={async () => true}
				reload={async () => undefined}
				renderLink={({ children }) => children}
				onDirtyChange={() => undefined}
				onSignIn={() => undefined}
				onConnectAgent={() => undefined}
				connectionAccessSummary={() => ""}
			/>,
		);
		expect(everyoneView).not.toContain("can’t use");
		expect(everyoneView).toContain("Unset tools are left to each agent.");
		const filtered = renderToStaticMarkup(
			<AccessManager
				data={noAccess}
				api={{} as never}
				view={{ server: "c1", query: "re" }}
				onViewChange={() => undefined}
				catalogs={{ c1: ready }}
				loadCatalog={() => undefined}
				busy={false}
				save={async () => true}
				reload={async () => undefined}
				renderLink={({ children }) => children}
				onDirtyChange={() => undefined}
				onSignIn={() => undefined}
				onConnectAgent={() => undefined}
				connectionAccessSummary={() => ""}
			/>,
		);
		expect(filtered).not.toContain("can’t use");
	});

	it("explains the three states in one line, true for inherited access", () => {
		expect(render()).toContain(
			"Allow runs without review. Ask requires approval for each call. Unset tools are not allowed.",
		);
		const full: Snapshot = {
			...data,
			grants: [
				{ agentId: "a1", connectionId: "c1", rules: rules({ full: true }) },
			],
		};
		expect(render(ready, full)).toContain(
			"“Everything” allows unset tools unless Everyone blocks them or requires approval.",
		);
	});

	it("keeps “Everything” and add-by-name under More options, open while in use", () => {
		const closed = render();
		expect(closed).toMatch(/aria-expanded="false"[^>]*>.*More options/);
		expect(closed).toMatch(/id="[^"]*-more" hidden=""/);
		const full: Snapshot = {
			...data,
			grants: [
				{ agentId: "a1", connectionId: "c1", rules: rules({ full: true }) },
			],
		};
		expect(render(ready, full)).toMatch(
			/aria-expanded="true"[^>]*>.*More options/,
		);
		// Adding by name is the only way in while the list is not loaded.
		expect(
			render({ status: "error", message: "Internal server error" }),
		).toMatch(/aria-expanded="true"[^>]*>.*More options/);
		// The agent head keeps its focus target.
		expect(closed).toContain('id="access-agent-a1" tabindex="-1"');
	});

	it("lists Toolstile's built-in tools apart from the connection's", () => {
		const html = render();
		expect(html).toContain("Built into Toolstile");
		for (const name of ["search_catalog", "get_catalog_entry", "get_my_access"])
			expect(html).toContain(`>${name}</code>`);
		expect(html).toContain(
			"Every connected agent has these. They are read-only and are not part of any connection.",
		);
		expect(html.match(/Always available/g)).toHaveLength(3);
		// They are not counted with the connection's tools.
		expect(html).toContain("Tools 3");
		// They are not on the resources tab.
		const resources = renderToStaticMarkup(
			<AccessManager
				data={data}
				api={{} as never}
				view={{ server: "c1", capability: "resources" }}
				onViewChange={() => undefined}
				catalogs={{ c1: ready }}
				loadCatalog={() => undefined}
				busy={false}
				save={async () => true}
				reload={async () => undefined}
				renderLink={({ children }) => children}
				onDirtyChange={() => undefined}
				onSignIn={() => undefined}
				onConnectAgent={() => undefined}
				connectionAccessSummary={() => ""}
			/>,
		);
		expect(resources).not.toContain("Built into Toolstile");
	});

	it("tags tools with what the server declares, without changing access", () => {
		const html = render({
			...ready,
			data: {
				...ready.data,
				hints: [
					{ name: "read", readOnly: true },
					{ name: "drop", destructive: true },
				],
			},
		});
		expect(html).toContain(
			'title="Declared by Mail. Toolstile does not verify it.">Read-only</span>',
		);
		expect(html).toContain(">Destructive</span>");
		expect(html).toContain(
			'aria-label="drop for Writer on Laptop: Not allowed"',
		);
	});

	it("shows a failed catalog in plain words with a next step", () => {
		const html = render({ status: "error", message: "Internal server error" });
		expect(html).not.toContain("Internal server error");
		expect(html).toContain("Couldn’t load the list of tools from Mail.");
		expect(html).toContain(
			"The server did not answer the request for its list.",
		);
		expect(html).toContain("Select Try again.");
		expect(html).toContain("Try again</button>");
	});
});

describe("rows added by name", () => {
	it("rejects control characters and overlong names", () => {
		expect(addNameProblem("send_mail", "tools")).toBe("");
		expect(addNameProblem("<script>alert(1)</script>", "tools")).toBe("");
		expect(addNameProblem("a\tb", "tools")).toMatch(/control character/);
		expect(addNameProblem("a".repeat(200), "tools")).toBe("");
		expect(addNameProblem("a".repeat(201), "tools")).toMatch(
			/200 characters or fewer/,
		);
		expect(addNameProblem("a".repeat(5000), "prompts")).toMatch(/has 5000/);
		expect(addNameProblem(`docs://${"a".repeat(249)}`, "resources")).toBe("");
		expect(addNameProblem(`docs://${"a".repeat(250)}`, "resources")).toMatch(
			/256 characters or fewer/,
		);
		expect(addNameProblem("read\u202Etool", "tools")).toMatch(
			/control character/,
		);
	});

	it("counts a typed row as unsaved until a rule keeps it", () => {
		const added = ["typed", "kept", "offered"];
		expect(unsavedRowNames(added, "tools", [rules()], ["offered"])).toEqual([
			"typed",
			"kept",
		]);
		expect(
			unsavedRowNames(
				added,
				"tools",
				[rules({ block: { ...emptyRules().block, tools: ["kept"] } })],
				["offered"],
			),
		).toEqual(["typed"]);
		expect(
			unsavedRowNames(["typed"], "tools", [
				rules({ requireApproval: ["typed"] }),
			]),
		).toEqual([]);
	});
});

describe("catalog problems", () => {
	it("keeps the server's own message and replaces generic errors", () => {
		expect(catalogProblem("Sign in to Linear again")).toBe(
			"Sign in to Linear again.",
		);
		expect(catalogProblem("The server took too long.")).toBe(
			"The server took too long.",
		);
		expect(catalogProblem("Internal server error")).toBe(
			"The server did not answer the request for its list.",
		);
	});
});

describe("starter selections", () => {
	const starter = {
		id: "read",
		name: "Read items",
		description: "Find and read items.",
		allow: ["find", "read", "gone"],
		requireApproval: ["save"],
	};
	const offered = ["find", "read", "save", "drop", "other"];

	it("adds the starter's offered tools to the draft and keeps existing access", () => {
		const own = rules({ allow: tools(["other"]) });
		const result = applyStarter(own, starter, offered);
		expect(result?.allowed).toEqual(["find", "read"]);
		expect(result?.approval).toEqual(["save"]);
		expect(result?.missing).toEqual(["gone"]);
		expect(result?.rules).toEqual(
			rules({
				allow: tools(["other", "find", "read"]),
				requireApproval: ["save"],
			}),
		);
		// Never “Everything”: unnamed and future tools stay ungranted.
		expect(result?.rules.full).toBe(false);
		expect(toolCell(must(result).rules, "drop").effect).toBe("off");
		// The saved rules are untouched; only the returned draft changes.
		expect(own).toEqual(rules({ allow: tools(["other"]) }));
	});

	it("never lifts a block or loosens an approval", () => {
		const own = rules({
			block: { ...emptyRules().block, tools: ["find"] },
			requireApproval: ["read"],
		});
		const everyone = rules({
			block: { ...emptyRules().block, tools: ["save"] },
		});
		const result = must(applyStarter(own, starter, offered, everyone));
		expect(result.blocked).toEqual(["save", "find"]);
		expect(result.approval).toEqual(["read"]);
		expect(result.allowed).toEqual([]);
		expect(toolCell(result.rules, "find").effect).toBe("blocked");
		expect(toolCell(result.rules, "save", everyone).effect).toBe("blocked");
		expect(toolCell(result.rules, "read").effect).toBe("approval");
		// An Everyone approval stays an approval for the agent.
		const gated = must(
			applyStarter(
				rules(),
				starter,
				offered,
				rules({ requireApproval: ["find"] }),
			),
		);
		expect(gated.approval).toContain("find");
		expect(gated.allowed).not.toContain("find");
	});

	it("offers nothing to apply under full access", () => {
		expect(applyStarter(rules({ full: true }), starter, offered)).toBeNull();
		expect(
			applyStarter(rules(), starter, offered, rules({ full: true })),
		).toBeNull();
	});

	const strip = (props: Partial<Parameters<typeof StarterStrip>[0]> = {}) =>
		renderToStaticMarkup(
			<StarterStrip
				starters={[starter]}
				applied={null}
				who="Writer on Laptop"
				full={false}
				busy={false}
				onApply={() => undefined}
				{...props}
			/>,
		);
	it("labels starters as a reviewed suggestion that adds to the draft", () => {
		const html = strip();
		expect(html).toContain("Suggested starting access");
		expect(html).toContain("not a guarantee");
		expect(html).toContain("existing access stays as it is");
		expect(html).toContain("Read items");
		expect(html).toContain("3 allowed · 1 requires approval");
		expect(
			strip({
				starters: [
					{ ...starter, allow: ["find"], requireApproval: ["save", "read"] },
				],
			}),
		).toContain("1 allowed · 2 require approval");
		expect(
			strip({ starters: [{ ...starter, requireApproval: undefined }] }),
		).toMatch(/>3 allowed</);
		expect(html).toContain("Allow: find, read, gone");
		expect(html).not.toContain("disabled");
		expect(strip({ full: true })).toContain("disabled");
	});

	it("names every tool the starter changed or left alone, before saving", () => {
		const html = strip({
			applied: {
				...must(
					applyStarter(
						rules({ block: { ...emptyRules().block, tools: ["read"] } }),
						starter,
						offered,
					),
				),
				name: "Read items",
			},
		});
		expect(html).toContain('role="status"');
		expect(html).toMatch(/Allowed: .*<code[^>]*>find<\/code>/);
		expect(html).toMatch(/Require approval: .*<code[^>]*>save<\/code>/);
		expect(html).toMatch(/Still blocked: .*<code[^>]*>read<\/code>/);
		expect(html).toMatch(/left out: .*<code[^>]*>gone<\/code>/);
		expect(html).toContain("Nothing is saved until you choose Save changes.");
		expect(html).toContain("Existing access stays as it is");
		expect(html).not.toMatch(/exactly|stay off|replace/i);
	});
});

function must<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Expected a value");
	return value;
}
