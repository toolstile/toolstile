// @vitest-environment happy-dom
import type { ManagementClient } from "@toolstile/api/client";
import type { Snapshot } from "@toolstile/api/contract";
import { act } from "react";
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

import { AccessPage } from "./AccessPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { Dashboard } from "./Dashboard";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const user = { name: "Test", email: "new-tools@example.test", operator: false };
const snapshot = (connections: Snapshot["connections"]): Snapshot => ({
	user,
	connections,
	devices: [],
	agents: [],
	grants: [],
	activity: [],
	allAgentGrants: [],
});
const connection = (status: string): Snapshot["connections"][number] => ({
	id: "c-new",
	label: "Tracker",
	url: "https://tracker.example.test/mcp",
	transport: "http",
	status,
	authentication: "headers",
	canManageAuthentication: true,
});
const existing = {
	...connection("reachable"),
	id: "c-old",
	url: "https://old.example.test/mcp",
};

let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	// Loaded tools are cached per browser; each test starts without them.
	localStorage.clear();
});

globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

function mount(verify: ManagementClient["verify"]) {
	const api = { verify } as unknown as ManagementClient;
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	return (
		data: Snapshot,
		oauth?: { status: "connected"; connectionId: string },
		section: "connections" | "access" = "connections",
	) =>
		act(() =>
			root?.render(
				<Dashboard
					section={section}
					onNavigate={() => undefined}
					renderNavigationLink={() => null}
					modal={null}
					onDialogChange={() => undefined}
					accessView={{}}
					onAccessViewChange={() => undefined}
					renderAccessLink={() => null}
					everyoneAccess={undefined}
					data={data}
					api={api}
					connectionRequests={{
						previewConnection: vi.fn(),
						connectConnector: vi.fn(),
					}}
					reload={async () => undefined}
					renderAccountMenu={() => null}
					connectionAccessSummary={() => ""}
					onSignOut={() => undefined}
					oauthStatus={oauth?.status}
					oauthConnectionId={oauth?.connectionId}
				>
					{section === "access" ? <AccessPage /> : <ConnectionsPage />}
				</Dashboard>,
			),
		);
}
const catalog = async () => ({ tools: [], resources: [], prompts: [] });
const rowText = () =>
	document.querySelector('[data-connection-row="c-new"]')?.textContent ?? "";

describe("tools of new connections", () => {
	it("load once when a new connection becomes reachable after waiting for approval", async () => {
		const verify = vi.fn(catalog);
		const render = mount(verify);
		// Connections listed on load ask no server.
		await render(snapshot([existing]));
		await render(snapshot([existing, connection("approval pending")]));
		expect(verify).not.toHaveBeenCalled();
		await render(snapshot([existing, connection("reachable")]));
		await render(snapshot([existing, connection("reachable")]));
		expect(verify).toHaveBeenCalledTimes(1);
		expect(verify).toHaveBeenCalledWith({ id: "c-new" });
	});
	it("checks nothing after sign-in for a member who may not check tools", async () => {
		const verify = vi.fn(catalog);
		const render = mount(verify);
		const signedIn = { ...connection("authenticated"), canCheckTools: false };
		await render(snapshot([signedIn]), {
			status: "connected",
			connectionId: "c-new",
		});
		await render(snapshot([signedIn]));
		expect(verify).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Tracker is signed in.");
		expect(rowText()).toContain("Connected");
		expect(rowText()).not.toContain("Load tools");
	});
	it("treats a refused automatic check as skipped, not failed", async () => {
		const verify = vi.fn(async () => {
			throw Object.assign(new Error("Unavailable or access denied"), {
				code: "FORBIDDEN",
				status: 403,
			});
		});
		const render = mount(verify);
		await render(snapshot([existing]));
		await act(async () => {
			await render(snapshot([existing, connection("reachable")]));
		});
		expect(verify).toHaveBeenCalledTimes(1);
		await render(snapshot([existing, connection("reachable")]));
		// The status badge is untouched; the tools column says why there are none.
		expect(rowText()).toContain("Connected");
		expect(rowText()).not.toMatch(/Unreachable|Needs/);
		expect(rowText()).toContain("Tools could not load");
	});
	it("never marks a contributor's connection failed from sign-in through Access and back", async () => {
		const agent = {
			id: "a1",
			label: "Writer",
			deviceId: "d1",
			revoked: false,
			expiresAt: null,
			canTest: true,
		};
		const withAgent = (connections: Snapshot["connections"]) => ({
			...snapshot(connections),
			devices: [{ id: "d1", label: "Laptop", revoked: false }],
			agents: [agent],
		});
		// The server refuses discovery for this member whether or not the page asked.
		const verify = vi.fn(async () => {
			throw Object.assign(new Error("Unavailable or access denied"), {
				code: "FORBIDDEN",
				status: 403,
			});
		});
		const render = mount(verify);
		const contributor = {
			...connection("authenticated"),
			canCheckTools: false,
		};
		await render(withAgent([contributor]), {
			status: "connected",
			connectionId: "c-new",
		});
		expect(document.body.textContent).toContain("Tracker is signed in.");
		// "Choose agent access" opens Access for the connection.
		await act(async () => {
			await render(withAgent([contributor]), undefined, "access");
		});
		// The access editor is open for the agent, without tool checks.
		expect(document.body.textContent).toContain("Writer");
		expect(document.body.textContent).not.toMatch(
			/Refresh tools|Try again|Couldn’t load|Loading tools/,
		);
		await act(async () => {
			await render(withAgent([contributor]));
		});
		expect(verify).not.toHaveBeenCalled();
		expect(rowText()).toContain("Connected");
		expect(rowText()).not.toMatch(/Unreachable|Needs|could not load/);
		// Where the snapshot does not say, Access's own load is automatic: a refusal is skipped once.
		const unknown = { ...connection("authenticated") };
		await act(async () => {
			await render(withAgent([unknown]), undefined, "access");
		});
		await act(async () => {
			await render(withAgent([unknown]), undefined, "access");
		});
		expect(verify).toHaveBeenCalledTimes(1);
		// Settled, not loading forever, and Try again still asks the server.
		expect(document.body.textContent).not.toContain("Loading tools");
		expect(document.body.textContent).toContain("Try again");
		await act(async () => {
			await render(withAgent([unknown]));
		});
		expect(rowText()).toContain("Connected");
		expect(rowText()).not.toMatch(/Unreachable|Needs/);
	});
});
