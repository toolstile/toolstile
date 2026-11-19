import type { Snapshot } from "@toolstile/api/contract";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@stylexjs/stylex", () => ({
	create: <T,>(value: T) => value,
	defineVars: <T,>(value: T) => value,
	keyframes: () => "",
	firstThatWorks: (value: string) => value,
	defaultMarker: () => ({}),
	when: { ancestor: () => ":hover" },
	props: () => ({}),
}));

import { emptyRules } from "./access-rules";
import { automaticSelection, SetupGuide, toolSummary } from "./SetupGuide";
import type { SetupApi, SetupState } from "./setup-contract";

const connection = {
	id: "c1",
	label: "deepwiki.com",
	status: "connected",
	authentication: "none",
	url: "https://mcp.deepwiki.com/mcp",
};
const agent = (id: string, label = id) => ({
	id,
	label,
	revoked: false,
	canTest: true,
	expiresAt: null,
});
const snapshot = (patch: Partial<Record<keyof Snapshot, unknown>> = {}) =>
	({
		connections: [connection],
		agents: [],
		grants: [],
		allAgentGrants: [],
		...patch,
	}) as unknown as Snapshot;
const state = (patch: Partial<SetupState> = {}): SetupState => ({
	status: "active",
	step: "connect",
	client: "claude-code",
	connectionId: "c1",
	completed: {
		connect: true,
		agent: false,
		access: false,
		verify: false,
		call: false,
	},
	verifiedAt: null,
	firstCall: null,
	...patch,
});
const api = (): SetupApi => ({
	setupStatus: vi.fn(),
	setupAgents: vi.fn(async () => ({ agentIds: [] })),
	saveSetup: vi.fn(),
	verifySetup: vi.fn(),
	setupFirstCall: vi.fn(async () => ({ firstCall: null })),
});
function render(
	setup: SetupState,
	data: Snapshot,
	setupApi = api(),
	props: { onViewCall?(id: string): void; firstCallNote?: string } = {},
) {
	return renderToStaticMarkup(
		<SetupGuide
			state={setup}
			api={setupApi}
			data={data}
			endpoint="https://toolstile.example/mcp"
			onState={() => undefined}
			onDialog={() => undefined}
			onConfigureAccess={() => undefined}
			onDone={() => undefined}
			{...props}
		/>,
	);
}
const granted = () =>
	snapshot({
		agents: [agent("a", "Claude Code")],
		grants: [
			{
				agentId: "a",
				connectionId: "c1",
				rules: {
					...emptyRules(),
					allow: { ...emptyRules().allow, tools: ["ask_wiki_question"] },
				},
			},
		],
	});
const verified = (patch: Partial<SetupState> = {}) =>
	state({
		step: "verify",
		agentId: "a",
		completed: {
			connect: true,
			agent: true,
			access: true,
			verify: true,
			call: false,
		},
		verifiedAt: "2026-10-28T00:00:00.000Z",
		...patch,
	});
const called = verified({
	completed: {
		connect: true,
		agent: true,
		access: true,
		verify: true,
		call: true,
	},
	firstCall: {
		id: "act-1",
		target: "ask_wiki_question",
		createdAt: "2026-10-28T00:01:00.000Z",
		failed: false,
	},
});

describe("automatic setup selections", () => {
	it("selects the agent a token creates from step 2 and moves on to access", () => {
		expect(
			automaticSelection({
				step: "agent",
				connections: [connection],
				agentIds: ["old", "new"],
				connectionId: "c1",
				agentId: "old",
				knownAgentIds: new Set(["old"]),
				tokenBaseline: new Set(["old"]),
			}),
		).toEqual({ setupAgentId: "new", setupStep: "access" });
	});
	it("waits while the token dialog is open without a new agent", () => {
		expect(
			automaticSelection({
				step: "agent",
				connections: [connection],
				agentIds: ["a", "b"],
				knownAgentIds: new Set(["a", "b"]),
				tokenBaseline: new Set(["a", "b"]),
			}),
		).toBeUndefined();
	});
	it("selects an agent that signs in during step 2 and moves on to access", () => {
		expect(
			automaticSelection({
				step: "agent",
				connections: [connection],
				agentIds: ["a", "b", "signed-in"],
				agentId: "a",
				knownAgentIds: new Set(["a", "b"]),
			}),
		).toEqual({ setupAgentId: "signed-in", setupStep: "access" });
		// Back from access to that agent does not move on again.
		expect(
			automaticSelection({
				step: "agent",
				connections: [connection],
				agentIds: ["a", "signed-in"],
				agentId: "signed-in",
				knownAgentIds: new Set(["a"]),
			}),
		).toBeUndefined();
		// An agent that existed before step 2 is selected, and Continue stays with the user.
		expect(
			automaticSelection({
				step: "agent",
				connections: [connection],
				agentIds: ["a"],
				knownAgentIds: new Set(["a"]),
			}),
		).toEqual({ setupAgentId: "a" });
	});
	it("fills a missing selection in the access step from the only candidate", () => {
		const base = { step: "access" as const, connections: [connection] };
		expect(
			automaticSelection({ ...base, agentIds: ["a"], connectionId: "c1" }),
		).toEqual({ setupAgentId: "a" });
		expect(automaticSelection({ ...base, agentIds: ["a"] })).toEqual({
			setupConnectionId: "c1",
			setupAgentId: "a",
		});
		expect(
			automaticSelection({ ...base, agentIds: ["a", "b"], connectionId: "c1" }),
		).toBeUndefined();
		expect(
			automaticSelection({
				...base,
				agentIds: ["a"],
				connectionId: "c1",
				agentId: "a",
			}),
		).toBeUndefined();
	});
	it("moves on from step 1 once the selected connection is ready", () => {
		const reachable = { id: "c1", status: "reachable" };
		const base = {
			step: "connect" as const,
			agentIds: [],
			connectionId: "c1",
		};
		expect(
			automaticSelection({
				...base,
				connections: [reachable],
				connectReady: true,
			}),
		).toEqual({ setupStep: "agent" });
		// The server has not confirmed the selection yet.
		expect(
			automaticSelection({ ...base, connections: [reachable] }),
		).toBeUndefined();
		// The user went back to step 1.
		expect(
			automaticSelection({
				...base,
				connections: [reachable],
				connectReady: true,
				stayOnConnect: true,
			}),
		).toBeUndefined();
		// Browser sign-in has not finished, or the server is unreachable.
		for (const status of ["authentication required", "needs attention"])
			expect(
				automaticSelection({
					...base,
					connections: [{ id: "c1", status }],
					connectReady: true,
					knownConnectionIds: new Set(["c1"]),
				}),
			).toBeUndefined();
		// Signed in after returning from the provider.
		expect(
			automaticSelection({
				...base,
				connections: [{ id: "c1", status: "authenticated" }],
				connectReady: true,
			}),
		).toEqual({ setupStep: "agent" });
	});
	it("selects a single connection or agent", () => {
		expect(
			automaticSelection({
				step: "connect",
				connections: [connection],
				agentIds: [],
			}),
		).toEqual({ setupConnectionId: "c1" });
		expect(
			automaticSelection({
				step: "agent",
				connections: [connection],
				agentIds: ["a"],
			}),
		).toEqual({ setupAgentId: "a" });
	});
	it("prefers a reachable connection over one that needs attention", () => {
		const junk = { id: "junk", status: "needs attention" };
		const good = { id: "good", status: "reachable" };
		// A single unreachable connection is selected so step 1 can say what is wrong.
		expect(
			automaticSelection({
				step: "connect",
				connections: [junk],
				agentIds: [],
				knownConnectionIds: new Set(),
			}),
		).toEqual({ setupConnectionId: "junk" });
		// A reachable connection added later replaces it.
		expect(
			automaticSelection({
				step: "connect",
				connections: [junk, good],
				agentIds: [],
				connectionId: "junk",
				knownConnectionIds: new Set(),
			}),
		).toEqual({ setupConnectionId: "good" });
		// Also after a reload, when it is the only reachable one.
		expect(
			automaticSelection({
				step: "connect",
				connections: [good, junk],
				agentIds: [],
				connectionId: "junk",
				knownConnectionIds: new Set(["good", "junk"]),
			}),
		).toEqual({ setupConnectionId: "good" });
		// Sign-in states are reachable.
		expect(
			automaticSelection({
				step: "connect",
				connections: [junk, { id: "oauth", status: "authentication required" }],
				agentIds: [],
			}),
		).toEqual({ setupConnectionId: "oauth" });
	});
	it("keeps a reachable choice and leaves several reachable ones to the user", () => {
		const a = { id: "a", status: "reachable" };
		const b = { id: "b", status: "reachable" };
		expect(
			automaticSelection({
				step: "connect",
				connections: [a, b],
				agentIds: [],
				connectionId: "a",
				knownConnectionIds: new Set(["a"]),
			}),
		).toBeUndefined();
		expect(
			automaticSelection({
				step: "connect",
				connections: [{ id: "junk", status: "needs attention" }, a, b],
				agentIds: [],
				connectionId: "junk",
				knownConnectionIds: new Set(["junk", "a", "b"]),
			}),
		).toBeUndefined();
		// Of several added while the guide is open, the newest wins.
		expect(
			automaticSelection({
				step: "connect",
				connections: [{ id: "junk", status: "needs attention" }, a, b],
				agentIds: [],
				connectionId: "junk",
				knownConnectionIds: new Set(["junk"]),
			}),
		).toEqual({ setupConnectionId: "b" });
	});
	it("never finishes setup on its own after verification", () => {
		for (const step of ["access", "verify"] as const)
			expect(
				automaticSelection({
					step,
					connections: [connection],
					agentIds: ["a"],
					connectionId: "c1",
					agentId: "a",
				}),
			).toBeUndefined();
	});
});

describe("guided setup card", () => {
	it("explains agents and offers an agent token in step 2", () => {
		const html = render(state({ step: "agent" }), snapshot());
		expect(html).toContain("An agent is an AI app or script");
		expect(html).toContain("No AI app on this device?");
		expect(html).toContain("Create an agent token");
		expect(html).toContain("Run this in a terminal.");
		expect(html).toContain("claude mcp add --transport http toolstile");
	});
	it("does not continue from step 1 with a connection it can't reach", () => {
		const html = render(
			state(),
			snapshot({
				connections: [{ ...connection, status: "needs attention" }],
			}),
		);
		expect(html).toContain(
			"Toolstile could not reach an MCP server at the address of",
		);
		const waiting = html.match(
			/<p id="([^"]+-waiting)"[^>]*>Choose a connection Toolstile can reach\.<\/p>/,
		);
		expect(waiting).not.toBeNull();
		expect(html).toMatch(
			new RegExp(
				`<button type="button" disabled="" aria-describedby="${waiting?.[1]}">Continue`,
			),
		);
	});
	it("keeps Continue disabled while waiting and says why", () => {
		const html = render(state({ step: "agent" }), snapshot());
		const waiting = html.match(
			/<p id="([^"]+-waiting)"[^>]*>Waiting for your agent to sign in\.<\/p>/,
		);
		expect(waiting).not.toBeNull();
		expect(html).toMatch(
			new RegExp(
				`<button type="button" disabled="" aria-describedby="${waiting?.[1]}">Continue`,
			),
		);
	});
	it("asks for the first call once access is verified and keeps Finish disabled", () => {
		const setupApi = api();
		const html = render(verified(), granted(), setupApi, {
			firstCallNote: "Host note.",
		});
		expect(html).toContain("Step 4 of 4 · Make your first call");
		expect(html).not.toContain("Setup complete");
		expect(html).toContain(
			"Claude Code can use 1 tool (ask_wiki_question) on deepwiki.com.",
		);
		expect(html).toContain(
			"Restart Claude Code so it loads the Toolstile tools.",
		);
		expect(html).toContain(
			"List the deepwiki.com tools you have through Toolstile, then call one that only reads data and show me what it returns.",
		);
		expect(html).toContain('aria-label="Copy prompt"');
		expect(html).toContain(
			"Waiting for Claude Code&#x27;s first tool call on deepwiki.com…",
		);
		expect(html).toContain("Host note.");
		const waiting = html.match(
			/<p id="([^"]+-waiting)"[^>]*>Waiting for the first call\.<\/p>/,
		);
		expect(waiting).not.toBeNull();
		expect(html).toMatch(
			new RegExp(
				`<button type="button" disabled="" aria-describedby="${waiting?.[1]}">Finish`,
			),
		);
		expect(html).not.toContain(">Back<");
		expect(setupApi.saveSetup).not.toHaveBeenCalled();
	});
	it("names a token agent when its app is unknown", () => {
		const data = granted();
		data.agents[0].label = "Build server";
		expect(render(verified(), data)).toContain(
			"Restart Build server so it loads the Toolstile tools.",
		);
	});
	it("falls back to step 3 while access is not verified", () => {
		const html = render(
			verified({
				completed: {
					connect: true,
					agent: true,
					access: true,
					verify: false,
					call: false,
				},
			}),
			granted(),
		);
		expect(html).toContain("Step 3 of 4 · Give access");
		expect(html).not.toContain("Make your first call");
		expect(html).toContain(">Back<");
	});
	it("shows the first call and enables Finish", () => {
		const html = render(called, granted());
		expect(html).toContain("Setup complete");
		expect(html).toContain("First call received.");
		expect(html).toMatch(
			/Claude Code called <code>ask_wiki_question<\/code> on deepwiki\.com at /,
		);
		expect(html).toMatch(/<button type="button">Finish/);
		expect(html).not.toContain("View in Activity");
		expect(html).toContain("Select Finish to close the guide.");
	});
	it("offers the call in Activity when the host can open it", () => {
		const html = render(called, granted(), api(), {
			onViewCall: () => undefined,
		});
		expect(html).toContain("View in Activity");
	});
	it("describes a first call without a tool name", () => {
		const html = render(
			{
				...called,
				firstCall: {
					id: "act-1",
					target: null,
					createdAt: "2026-10-28T00:01:00.000Z",
					failed: false,
				},
			},
			granted(),
		);
		expect(html).toContain("Claude Code called a tool on deepwiki.com at ");
	});
	it("shows four steps in the docked card", () => {
		const docked = (setup: SetupState, onViewCall?: (id: string) => void) =>
			renderToStaticMarkup(
				<SetupGuide
					state={setup}
					api={api()}
					data={granted()}
					endpoint="https://toolstile.example/mcp"
					onState={() => undefined}
					onDialog={() => undefined}
					onConfigureAccess={() => undefined}
					onDone={() => undefined}
					onViewCall={onViewCall}
					variant="docked"
				/>,
			);
		const waitingCard = docked(verified());
		expect(waitingCard).toContain("4 of 4");
		expect(waitingCard).toContain("Waiting for Claude Code&#x27;s first call");
		expect(waitingCard).toContain(">Show prompt<");
		expect(waitingCard).toContain(">Details<");
		const doneCard = docked(called, () => undefined);
		expect(doneCard).toContain(
			"Claude Code called ask_wiki_question on deepwiki.com",
		);
		expect(doneCard).toContain(">View call<");
		expect(doneCard).not.toContain(">Details<");
		expect(docked(called)).toContain(">Details<");
	});
});

describe("permitted tool summary", () => {
	it("names a few tools, counts more and describes full access", () => {
		const allow = (tools: string[]) => ({
			...emptyRules(),
			allow: { ...emptyRules().allow, tools },
		});
		expect(toolSummary([allow(["a", "b"])])).toBe("2 tools (a, b)");
		expect(toolSummary([allow(["a", "b", "c", "d"])])).toBe("4 tools");
		expect(toolSummary([{ ...emptyRules(), full: true }])).toBe("all tools");
		expect(toolSummary([{ ...emptyRules(), requireApproval: ["send"] }])).toBe(
			"1 tool (send)",
		);
	});
});
