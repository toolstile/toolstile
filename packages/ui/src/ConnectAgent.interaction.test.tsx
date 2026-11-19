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

type Agent = {
	id: string;
	label: string;
	deviceId?: string;
	revoked: boolean;
};
type Device = { id: string; label: string; revoked: boolean };
const existing: Agent = { id: "a1", label: "Codex", revoked: false };
const hostSteps = vi.fn((app: { id: string; label: string }) => [
	{
		text: `Set up ${app.label}.`,
		code: `setup-tool --enable ${app.id}`,
		codeKind: "command",
	},
]);
const computerSetup: ComputerSetup = {
	label: "Setup tool",
	description: "Sets up agents on this computer.",
	clients: ["claude-code"],
	steps: hostSteps,
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	root = undefined;
	hostSteps.mockClear();
	vi.useRealTimers();
});

type Setter<T> = { current: (value: T) => void };
const setter = <T,>(): Setter<T> => ({ current: () => undefined });

function render(options: {
	reload?(): Promise<void>;
	grant?(agentId: string): void;
	agents?: Agent[];
	devices?: Device[];
	setAgents?: Setter<Agent[]>;
	setDevices?: Setter<Device[]>;
}) {
	function Host() {
		const [agents, setAgents] = useState(options.agents ?? []);
		const [devices, setDevices] = useState(options.devices ?? []);
		if (options.setAgents) options.setAgents.current = setAgents;
		if (options.setDevices) options.setDevices.current = setDevices;
		return (
			<ConnectAgentDialog
				endpoint="https://gateway.example/mcp"
				agents={agents}
				devices={devices}
				reload={options.reload ?? (async () => undefined)}
				computerSetup={computerSetup}
				onClose={() => undefined}
				onCreateToken={() => undefined}
				onGrantAccess={options.grant ?? (() => undefined)}
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

function type(value: string) {
	const search = document.querySelector<HTMLInputElement>(
		'input[type="search"]',
	);
	if (!search) throw new Error("No search field");
	act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(search, value);
		search.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

const heading = () => document.querySelector("h3")?.textContent ?? "";

describe("connect an agent", () => {
	it("filters apps, offers the host's setup first and waits for the new agent", async () => {
		vi.useFakeTimers();
		const reload = vi.fn(async () => undefined);
		const grant = vi.fn();
		const setAgents = setter<Agent[]>();
		render({ reload, grant, agents: [existing], setAgents });
		type("claude");
		expect(document.body.textContent).toContain("Claude Desktop");
		expect(document.body.textContent).not.toContain("Cursor");
		expect(document.body.textContent).not.toContain("Show all");

		act(() => button("Claude Code").click());
		expect(document.body.textContent).toContain("Setup tool (recommended)");
		expect(hostSteps).toHaveBeenCalledWith({
			id: "claude-code",
			label: "Claude Code",
		});
		expect(document.body.textContent).toContain(
			"setup-tool --enable claude-code",
		);
		expect(document.body.textContent).toContain(
			"Waiting for this computer to sign in.",
		);
		act(() => button("Claude Code only").click());
		expect(document.body.textContent).toContain(
			"claude mcp add --transport http toolstile 'https://gateway.example/mcp'",
		);
		expect(document.body.textContent).not.toContain("&device_name=");
		const ssh = button("Connecting from a machine you reach over SSH?");
		expect(ssh.getAttribute("aria-expanded")).toBe("false");
		act(() => ssh.click());
		expect(ssh.getAttribute("aria-expanded")).toBe("true");
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
		expect(heading()).toBe("Claude Code signed in");
		expect(document.body.textContent).not.toContain("is connected");
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

	it("shows the popular apps first and the rest on request", () => {
		render({});
		const popular = document.querySelector("section");
		expect(popular?.querySelector("h3")?.textContent).toBe("Popular");
		expect(popular?.querySelectorAll("li")).toHaveLength(6);
		expect(document.body.textContent).toContain("ChatGPT");
		expect(document.body.textContent).not.toContain("Cline");
		const toggle = button("Show all");
		expect(toggle.textContent).toMatch(/^Show all \d+ apps$/);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");

		act(() => toggle.click());
		expect(document.body.textContent).toContain("Cline");
		expect(document.body.textContent).toContain("On a computer");
		expect(document.body.textContent).not.toContain("Popular");
		expect(toggle.textContent).toBe("Show fewer");
		expect(toggle.getAttribute("aria-expanded")).toBe("true");

		act(() => toggle.click());
		expect(document.body.textContent).not.toContain("Cline");
	});

	it("follows the computer's sign-in, then names it when the agent is set up", () => {
		const setAgents = setter<Agent[]>();
		const setDevices = setter<Device[]>();
		const laptop: Device = { id: "d2", label: "Work laptop", revoked: false };
		render({
			devices: [{ id: "d1", label: "Old desktop", revoked: false }],
			setAgents,
			setDevices,
		});
		act(() => button("Claude Code").click());
		expect(document.body.textContent).toContain(
			"Waiting for Claude Code to be set up. This updates on its own.",
		);
		act(() =>
			setDevices.current([
				{ id: "d1", label: "Old desktop", revoked: false },
				{ id: "d3", label: "Revoked box", revoked: true },
			]),
		);
		expect(document.body.textContent).toContain(
			"Waiting for Claude Code to be set up. This updates",
		);
		act(() =>
			setDevices.current([
				{ id: "d1", label: "Old desktop", revoked: false },
				laptop,
			]),
		);
		expect(
			Array.from(document.querySelectorAll('[role="status"]')).at(-1)
				?.textContent,
		).toBe("Work laptop is signed in. Waiting for Claude Code to be set up.");

		act(() =>
			setAgents.current([
				{ id: "a2", label: "Claude Code", deviceId: "d2", revoked: false },
			]),
		);
		expect(heading()).toBe("Claude Code is set up on Work laptop");
		expect(document.body.textContent).toContain(
			"Restart Claude Code if it is running. It has not made a request yet",
		);

		act(() => button("Connect another agent").click());
		act(() => button("Claude Code").click());
		expect(document.body.textContent).toContain(
			"Waiting for Claude Code to be set up. This updates",
		);
		act(() =>
			setAgents.current([
				{ id: "a2", label: "Claude Code", deviceId: "d2", revoked: false },
				{ id: "a3", label: "Claude Code", deviceId: "gone", revoked: false },
			]),
		);
		expect(heading()).toBe("Claude Code is set up on this computer");
	});

	it("returns to the picker from an agent that arrived after Back", () => {
		const setAgents = setter<Agent[]>();
		render({ setAgents });
		act(() => button("Codex").click());
		act(() => button("Back").click());
		act(() =>
			setAgents.current([{ id: "late", label: "Codex", revoked: false }]),
		);
		expect(heading()).toBe("Codex was added");
		expect(document.body.textContent).toContain(
			"It can't use any MCP connections until you give it access.",
		);
		act(() => button("Connect another agent").click());
		expect(document.body.textContent).not.toContain("was added");
		expect(document.activeElement).toBe(
			document.querySelector('input[type="search"]'),
		);
	});

	it("sends token apps to an agent token without waiting", async () => {
		vi.useFakeTimers();
		const reload = vi.fn(async () => undefined);
		render({ reload });
		type("n8n");
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
