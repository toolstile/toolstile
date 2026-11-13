// @vitest-environment happy-dom
import type { ConnectorStarter } from "@toolstile/api/connectors";
import type { Rules, Snapshot } from "@toolstile/api/contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@stylexjs/stylex", () => ({
	create: <T,>(value: T) => value,
	defineVars: <T,>(value: T) => value,
	keyframes: () => "",
	defaultMarker: () => ({}),
	when: { ancestor: () => ":hover" },
	props: () => ({}),
}));

import { AccessManager, type CatalogState } from "./AccessManager";
import { emptyRules } from "./access-rules";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const saved: Rules = {
	...emptyRules(),
	allow: { ...emptyRules().allow, tools: ["kept"] },
	block: { ...emptyRules().block, tools: ["drop"] },
};
const data: Snapshot = {
	user: { name: "Test", email: "test@example.test", operator: false },
	connections: [
		{
			id: "c1",
			label: "Tracker",
			url: "https://tracker.example.test/mcp",
			transport: "http",
			status: "reachable",
			authentication: "headers",
			canManageAuthentication: true,
			connectorId: "example-tracker",
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
	grants: [{ agentId: "a1", connectionId: "c1", rules: saved }],
	activity: [],
	allAgentGrants: [],
};
const catalog: CatalogState = {
	status: "ready",
	data: {
		tools: ["read", "send", "drop", "kept", "other"],
		resources: [],
		prompts: [],
	},
	checkedAt: "2026-10-30T00:00:00.000Z",
};
const starter: ConnectorStarter = {
	id: "read",
	name: "Read items",
	description: "Find and read items.",
	allow: ["read", "drop"],
	requireApproval: ["send"],
};

let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

async function mount() {
	const saveGrant = vi.fn(async () => ({}));
	const save = vi.fn(async (work: () => Promise<unknown>) => {
		await work();
		return true;
	});
	const loadStarters = vi.fn(async () => [starter]);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<AccessManager
				data={data}
				api={{ saveGrant } as never}
				view={{ server: "c1", agent: "a1" }}
				onViewChange={() => undefined}
				catalogs={{ c1: catalog }}
				loadCatalog={() => undefined}
				busy={false}
				save={save}
				reload={async () => undefined}
				renderLink={({ children }) => children}
				onDirtyChange={() => undefined}
				onSignIn={() => undefined}
				onConnectAgent={() => undefined}
				connectionAccessSummary={() => ""}
				loadStarters={loadStarters}
			/>,
		);
	});
	return { container, save, saveGrant, loadStarters };
}
const button = (container: HTMLElement, text: string) => {
	const found = Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent?.includes(text),
	);
	if (!found) throw new Error(`No button with “${text}”`);
	return found;
};
const mode = (container: HTMLElement, tool: string) =>
	container
		.querySelector(`[aria-label^="${tool} for Writer on Laptop:"]`)
		?.getAttribute("aria-label")
		?.split(": ")[1];

describe("applying a starter in the access editor", () => {
	it("only changes the draft: nothing is saved until Save changes", async () => {
		const { container, save, saveGrant, loadStarters } = await mount();
		expect(loadStarters).toHaveBeenCalledWith({
			connectorId: "example-tracker",
			url: "https://tracker.example.test/mcp",
		});
		await act(async () => button(container, "Read items").click());
		expect(save).not.toHaveBeenCalled();
		expect(saveGrant).not.toHaveBeenCalled();
		// The draft shows the starter's tools; existing access and blocks stay.
		expect(mode(container, "read")).toBe("Allowed");
		expect(mode(container, "send")).toBe("Requires approval");
		expect(mode(container, "drop")).toBe("Blocked");
		expect(mode(container, "kept")).toBe("Allowed");
		expect(mode(container, "other")).toBe("Not allowed");
		expect(container.textContent).toContain("2 changes not saved");
		expect(container.querySelector('[role="status"]')?.textContent).toContain(
			"Existing access stays as it is",
		);

		await act(async () => button(container, "Save changes").click());
		expect(save).toHaveBeenCalledTimes(1);
		expect(saveGrant).toHaveBeenCalledTimes(1);
		expect(saveGrant).toHaveBeenCalledWith({
			agentId: "a1",
			connectionId: "c1",
			rules: {
				...saved,
				allow: { ...saved.allow, tools: ["kept", "read"] },
				requireApproval: ["send"],
			},
		});
	});

	it("discarding drops the applied starter without saving", async () => {
		const { container, save, saveGrant } = await mount();
		await act(async () => button(container, "Read items").click());
		await act(async () => button(container, "Discard").click());
		expect(save).not.toHaveBeenCalled();
		expect(saveGrant).not.toHaveBeenCalled();
		expect(mode(container, "read")).toBe("Not allowed");
	});
});
