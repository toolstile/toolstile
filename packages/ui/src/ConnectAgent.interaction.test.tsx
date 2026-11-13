// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@stylexjs/stylex", () => ({
	create: <T,>(value: T) => value,
	defineVars: <T,>(value: T) => value,
	keyframes: () => "",
	firstThatWorks: (value: string) => value,
	defaultMarker: () => ({}),
	when: { ancestor: () => ":hover" },
	props: () => ({}),
}));

import { type ComputerSetup, ConnectAgentDialog } from "./ConnectAgent";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Agent = { id: string; label: string; revoked: boolean };
const existing: Agent = { id: "a1", label: "Codex", revoked: false };
const computerSetup: ComputerSetup = {
	label: "Setup tool",
	description: "Sets up every agent on this computer.",
	clients: ["claude-code"],
	steps: [{ text: "Run the tool.", code: "setup-tool", codeKind: "command" }],
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	root = undefined;
	vi.useRealTimers();
});

function render(options: {
	reload(): Promise<void>;
	grant(agentId: string): void;
	agents: { current: Agent[] };
	setAgents: { current: (agents: Agent[]) => void };
}) {
	function Host() {
		const [agents, setAgents] = useState(options.agents.current);
		options.setAgents.current = setAgents;
		return (
			<ConnectAgentDialog
				endpoint="https://gateway.example/mcp"
				agents={agents}
				reload={options.reload}
				computerSetup={computerSetup}
				onClose={() => undefined}
				onCreateToken={() => undefined}
				onGrantAccess={options.grant}
			/>
		);
	}
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root?.render(<Host />));
}

const button = (label: string) => {
	const match = Array.from(document.querySelectorAll("button, a")).find(
		(element) => element.textContent?.trim().startsWith(label),
	);
	if (!(match instanceof HTMLElement)) throw new Error(`No ${label} control`);
	return match;
};

describe("connect an agent", () => {
	it("filters apps, offers the host's setup first and waits for the new agent", async () => {
		vi.useFakeTimers();
		const reload = vi.fn(async () => undefined);
		const grant = vi.fn();
		const setAgents: { current: (agents: Agent[]) => void } = {
			current: () => undefined,
		};
		render({
			reload,
			grant,
			agents: { current: [existing] },
			setAgents,
		});
		const search = document.querySelector<HTMLInputElement>(
			'input[type="search"]',
		);
		if (!search) throw new Error("No search field");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(search, "claude");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(document.body.textContent).toContain("Claude Desktop");
		expect(document.body.textContent).not.toContain("Cursor");

		act(() => button("Claude Code").click());
		expect(document.body.textContent).toContain("Setup tool (recommended)");
		expect(document.body.textContent).toContain("setup-tool");
		act(() => button("Claude Code only").click());
		expect(document.body.textContent).toContain(
			"claude mcp add --transport http toolstile 'https://gateway.example/mcp'",
		);
		expect(document.body.textContent).toContain("&device_name=");
		expect(document.body.textContent).toContain(
			"Waiting for Claude Code to sign in",
		);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(reload).toHaveBeenCalledTimes(1);

		act(() =>
			setAgents.current([
				existing,
				{ id: "a2", label: "Claude Code", revoked: false },
			]),
		);
		expect(document.body.textContent).toContain("Claude Code is connected");
		act(() => button("Choose what it can use").click());
		expect(grant).toHaveBeenCalledWith("a2");

		act(() => button("Connect another agent").click());
		expect(document.activeElement).toBe(
			document.querySelector('input[type="search"]'),
		);
		act(() => button("Claude Desktop").click());
		expect(document.activeElement?.textContent).toBe("Claude Desktop");
		act(() => button("Back").click());
		expect(document.activeElement).toBe(
			document.querySelector('input[type="search"]'),
		);
	});

	it("returns to the picker from an agent that arrived after Back", () => {
		const setAgents: { current: (agents: Agent[]) => void } = {
			current: () => undefined,
		};
		render({
			reload: vi.fn(async () => undefined),
			grant: vi.fn(),
			agents: { current: [] },
			setAgents,
		});
		act(() => button("Codex").click());
		act(() => button("Back").click());
		act(() =>
			setAgents.current([{ id: "late", label: "Codex", revoked: false }]),
		);
		expect(document.body.textContent).toContain("Codex is connected");
		act(() => button("Connect another agent").click());
		expect(document.body.textContent).not.toContain("is connected");
		expect(document.activeElement).toBe(
			document.querySelector('input[type="search"]'),
		);
	});

	it("sends token apps to an agent token without waiting", async () => {
		vi.useFakeTimers();
		const reload = vi.fn(async () => undefined);
		render({
			reload,
			grant: vi.fn(),
			agents: { current: [] },
			setAgents: { current: () => undefined },
		});
		act(() => button("n8n").click());
		expect(document.body.textContent).toContain("Connects with an agent token");
		expect(document.body.textContent).not.toContain("Waiting for");
		expect(document.body.textContent).not.toContain("(recommended)");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect(reload).not.toHaveBeenCalled();
	});
});
