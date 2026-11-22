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

const toasts = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ Toaster: () => null, toast: toasts }));

import { Dashboard } from "./Dashboard";
import { ToastViewport } from "./Toast";
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
function render(
	localCommands?: LocalCommandHost,
	reload: () => Promise<void> = async () => undefined,
) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const onDialogChange = vi.fn();
	// Saving from the catalog leaves it: the page, and with it the view's scope, changes.
	const view = (scopeKey: string, open: boolean) =>
		root?.render(
			<>
				<ToastViewport />
				<Dashboard
					section="connections"
					scopeKey={scopeKey}
					onNavigate={() => view("/app/connections", false)}
					renderNavigationLink={() => null}
					modal={open ? "connection" : null}
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
					reload={reload}
					renderAccountMenu={() => null}
					connectionAccessSummary={() => ""}
					onSignOut={() => undefined}
				/>
			</>,
		);
	act(() => view("/app/connections/catalog", true));
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

it("treats a saved command as added when the page then fails to refresh", async () => {
	const add = vi.fn(async () => ({ id: "c-local" }));
	const { onDialogChange } = render({ add }, async () => {
		throw new Error("Network down");
	});
	act(() => button("Run a local command instead")?.click());
	type("command", "uvx");
	await act(async () => button("Add command")?.click());
	expect(add).toHaveBeenCalledTimes(1);
	// No failure inside the form that would invite adding it again.
	expect(document.querySelector('[role="alert"]')).toBeNull();
	expect(onDialogChange).toHaveBeenCalledWith(null);
});

it("closes the dialog once the command is saved, while the page still refreshes", async () => {
	const add = vi.fn(async () => ({ id: "c-local" }));
	const { onDialogChange } = render({ add }, () => new Promise(() => {}));
	act(() => button("Run a local command instead")?.click());
	type("command", "uvx");
	await act(async () => button("Add command")?.click());
	expect(add).toHaveBeenCalledTimes(1);
	expect(onDialogChange).toHaveBeenCalledWith(null);
});

it("confirms the save and reports a failed refresh after leaving the catalog", async () => {
	toasts.success.mockClear();
	toasts.error.mockClear();
	const add = vi.fn(async () => ({ id: "c-local" }));
	render({ add }, async () => {
		throw new Error("Network down");
	});
	act(() => button("Run a local command instead")?.click());
	type("command", "uvx");
	await act(async () => button("Add command")?.click());
	expect(toasts.success).toHaveBeenCalledWith(
		"Local command added",
		expect.anything(),
	);
	expect(toasts.error).toHaveBeenCalledWith(
		"Local command added. The page couldn't refresh; reload it to see the latest.",
		expect.anything(),
	);
});
