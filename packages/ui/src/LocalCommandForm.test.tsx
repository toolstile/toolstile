// @vitest-environment happy-dom
import type { ManagementClient } from "@toolstile/api/client";
import type { Snapshot } from "@toolstile/api/contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@stylexjs/stylex", () => ({
	create: <T,>(value: T) => value,
	defineVars: <T,>(value: T) => value,
	keyframes: () => "",
	firstThatWorks: (value: string) => value,
	defaultMarker: () => ({}),
	when: { ancestor: () => ":hover" },
	props: () => ({}),
}));

import { Dashboard } from "./Dashboard";
import type { LocalCommandHost } from "./LocalCommandForm";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

const data: Snapshot = {
	user: { name: "Operator", email: "operator@example.test", operator: true },
	connections: [],
	devices: [],
	agents: [],
	grants: [],
	activity: [],
	allAgentGrants: [],
};
let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});
function render(localCommands?: LocalCommandHost) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const onDialogChange = vi.fn();
	act(() =>
		root?.render(
			<Dashboard
				section="connections"
				onNavigate={() => undefined}
				renderNavigationLink={() => null}
				modal="connection"
				onDialogChange={onDialogChange}
				accessView={{}}
				onAccessViewChange={() => undefined}
				renderAccessLink={() => null}
				data={data}
				api={{} as ManagementClient}
				connectionRequests={{
					previewConnection: vi.fn(),
					connectConnector: vi.fn(),
				}}
				localCommands={localCommands}
				reload={async () => undefined}
				renderAccountMenu={() => null}
				connectionAccessSummary={() => ""}
				onSignOut={() => undefined}
			/>,
		),
	);
	return { onDialogChange };
}
const button = (label: string) =>
	[...document.querySelectorAll("button")].find(
		(item) => item.textContent === label,
	);
function type(name: string, value: string) {
	const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		`[name="${name}"]`,
	);
	if (!field) throw new Error(`No ${name} field`);
	field.value = value;
}

it("offers a local command only when the host passes one", () => {
	render();
	expect(button("Run a local command instead")).toBeUndefined();
});

it("sends the command, one argument per line and NAME=value variables", async () => {
	const add = vi.fn(async () => ({ id: "c-local" }));
	const { onDialogChange } = render({ add });
	act(() => button("Run a local command instead")?.click());
	expect(document.body.textContent).toContain("Add only commands you trust.");
	type("command", " npx ");
	type("args", "-y\n\n@modelcontextprotocol/server-everything\n");
	type("env", "API_KEY=abc=def\nREGION=eu");
	await act(async () => button("Add command")?.click());
	expect(add).toHaveBeenCalledWith({
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-everything"],
		env: { API_KEY: "abc=def", REGION: "eu" },
	});
	expect(onDialogChange).toHaveBeenCalledWith(null);
});

it("explains a variable line without a name and sends nothing", async () => {
	const add = vi.fn(async () => ({ id: "c-local" }));
	render({ add });
	act(() => button("Run a local command instead")?.click());
	type("command", "uvx");
	type("env", "=value");
	await act(async () => button("Add command")?.click());
	expect(add).not.toHaveBeenCalled();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"Write each variable as NAME=value",
	);
	act(() => button("Use a server address instead")?.click());
	expect(document.querySelector('[name="url"]')).not.toBeNull();
});
