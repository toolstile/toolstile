// @vitest-environment happy-dom
import type { ConnectorCatalogEntry } from "@toolstile/api/connectors";
import type {
	ConnectConnectorInput,
	ConnectionPreview,
	Snapshot,
} from "@toolstile/api/contract";
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

import {
	ConnectorCatalog,
	ConnectorConnectionForm,
	type ConnectorConnectionFormProps,
} from "./ConnectorCatalog";
import { leaveForSignIn, refreshOnReturn } from "./provider-sign-in";
import { UpstreamSignIn } from "./UpstreamSignIn";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (
	overrides: Partial<ConnectorCatalogEntry> = {},
): ConnectorCatalogEntry => ({
	slug: "tracker",
	name: "Tracker",
	publisher: "Tracker Inc",
	description: "Track issues.",
	categories: ["development"],
	keywords: [],
	capabilities: ["Find issues"],
	documentation: "https://tracker.example.test/docs",
	endpoint: "https://mcp.tracker.example.test/mcp",
	authMethods: ["oauth", "bearer"],
	fields: [],
	requirements: "A Tracker account.",
	starters: [],
	featured: false,
	logoUrl: null,
	...overrides,
});
const found = (
	overrides: Partial<ConnectionPreview> = {},
): ConnectionPreview => ({
	url: "https://mcp.tracker.example.test/mcp",
	transport: "http",
	authentication: "oauth",
	status: "authentication required",
	...overrides,
});

let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

async function render(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(node));
	return document.body;
}
async function mountForm(
	definition: ConnectorCatalogEntry,
	preview: ConnectorConnectionFormProps["preview"] = async () => found(),
) {
	const onSubmit = vi.fn<ConnectorConnectionFormProps["onSubmit"]>(
		async () => undefined,
	);
	const previewMock = vi.fn(preview);
	const body = await render(
		<ConnectorConnectionForm
			definition={definition}
			requestId="00000000-0000-4000-8000-000000000001"
			preview={previewMock}
			onClose={() => undefined}
			onSubmit={onSubmit}
		/>,
	);
	return { body, onSubmit, preview: previewMock };
}
const button = (body: HTMLElement, text: string) => {
	const match = Array.from(body.querySelectorAll("button")).find(
		(element) => element.textContent?.trim() === text,
	);
	if (!match) throw new Error(`No button “${text}”`);
	return match;
};
const hasButton = (body: HTMLElement, text: string) =>
	Array.from(body.querySelectorAll("button")).some(
		(element) => element.textContent?.trim() === text,
	);
async function submit(body: HTMLElement) {
	const form = body.querySelector("form");
	await act(async () => {
		form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
	});
}
function type(input: HTMLInputElement, value: string) {
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("ConnectorConnectionForm", () => {
	it("shows the catalog address read-only and signs in with one submit", async () => {
		const { body, onSubmit, preview } = await mountForm(entry());
		expect(body.querySelector("[role=combobox]")).toBeNull();
		expect(body.querySelector('input[inputmode="url"]')).toBeNull();
		expect(body.querySelector("code")?.textContent).toBe(
			"https://mcp.tracker.example.test/mcp",
		);
		expect(body.textContent).not.toContain("Confirm the server address");
		expect(hasButton(body, "Use an API key instead")).toBe(true);
		expect(button(body, "Continue to sign in").type).toBe("submit");
		await submit(body);
		expect(preview).toHaveBeenCalledWith(
			"https://mcp.tracker.example.test/mcp",
		);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
			url: "https://mcp.tracker.example.test/mcp",
			transport: "http",
			authentication: "oauth",
			headers: {},
			suggestionId: "tracker",
		});
	});

	it("offers only the catalog's other method, as a link", async () => {
		const { body, onSubmit } = await mountForm(entry());
		await act(async () => button(body, "Use an API key instead").click());
		expect(hasButton(body, "Use browser sign-in instead")).toBe(true);
		expect(hasButton(body, "Connect without sign-in instead")).toBe(false);
		const key = body.querySelector<HTMLInputElement>('input[name="apiKey"]');
		expect(key?.required).toBe(true);
		if (key) key.value = "secret-token";
		expect(hasButton(body, "Add connection")).toBe(true);
		await submit(body);
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
			authentication: "headers",
			headers: { Authorization: "Bearer secret-token" },
		});
	});

	it("shows no method choice for a single-method entry", async () => {
		const { body } = await mountForm(entry({ authMethods: ["oauth"] }));
		expect(body.textContent).not.toContain("instead");
		expect(body.querySelector('input[name="apiKey"]')).toBeNull();
	});

	it("makes the key optional where the entry works without sign-in", async () => {
		const { body, onSubmit } = await mountForm(
			entry({ authMethods: ["none", "bearer"] }),
			async () => found({ authentication: "headers", status: "reachable" }),
		);
		expect(body.textContent).not.toContain("instead");
		const key = body.querySelector<HTMLInputElement>('input[name="apiKey"]');
		expect(key?.required).toBe(false);
		expect(hasButton(body, "Add connection")).toBe(true);
		await submit(body);
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
			authentication: "headers",
			headers: {},
		});
	});

	it("applies settings to the shown and checked address", async () => {
		const { body, preview } = await mountForm(
			entry({
				authMethods: ["oauth"],
				fields: [
					{
						name: "project",
						label: "Project",
						kind: "identifier",
						required: true,
						help: "The project to use.",
					},
				],
			}),
		);
		await submit(body);
		expect(body.querySelector("[role=alert]")?.textContent).toContain(
			"Project is required",
		);
		expect(preview).not.toHaveBeenCalled();
		const input = body.querySelector<HTMLInputElement>("form input");
		if (input) type(input, "alpha");
		expect(body.querySelector("code")?.textContent).toBe(
			"https://mcp.tracker.example.test/mcp?project=alpha",
		);
		await submit(body);
		expect(preview).toHaveBeenCalledWith(
			"https://mcp.tracker.example.test/mcp?project=alpha",
		);
	});

	it("shows check and save failures inline and lets the person retry", async () => {
		let attempt = 0;
		const { body, onSubmit } = await mountForm(entry(), async () => {
			attempt += 1;
			if (attempt === 1) throw new Error("Network is down");
			if (attempt === 2) return found({ status: "needs attention" });
			return found();
		});
		await submit(body);
		expect(body.querySelector("[role=alert]")?.textContent).toBe(
			"Network is down",
		);
		await submit(body);
		expect(body.querySelector("[role=alert]")?.textContent).toContain(
			"could not reach Tracker's MCP server",
		);
		expect(onSubmit).not.toHaveBeenCalled();
		onSubmit.mockRejectedValueOnce(new Error("Already saving"));
		await submit(body);
		expect(body.querySelector("[role=alert]")?.textContent).toBe(
			"Already saving",
		);
		expect(button(body, "Continue to sign in").disabled).toBe(false);
	});

	it("refuses a catalog address that the check moved elsewhere", async () => {
		const { body, onSubmit } = await mountForm(entry(), async () =>
			found({ url: "https://mcp.tracker.example.test/sse" }),
		);
		await submit(body);
		expect(body.querySelector("[role=alert]")?.textContent).toContain(
			"add it with Custom URL",
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("saves a key-protected server the anonymous check could not use", async () => {
		const { body, onSubmit } = await mountForm(
			entry({ authMethods: ["bearer"] }),
			async () => {
				throw new Error("Refused");
			},
		);
		const key = body.querySelector<HTMLInputElement>('input[name="apiKey"]');
		if (key) key.value = "secret-token";
		await submit(body);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const input = onSubmit.mock.calls[0]?.[0];
		expect(input).toMatchObject({
			url: "https://mcp.tracker.example.test/mcp",
			authentication: "headers",
			headers: { Authorization: "Bearer secret-token" },
		});
		// No transport from a failed check: the save tries the exact address with each.
		expect(input && "transport" in input).toBe(false);
	});

	it("saves with a key even when the anonymous check finds nothing", async () => {
		const { body, onSubmit } = await mountForm(
			entry({ authMethods: ["bearer"] }),
			async () => found({ status: "needs attention" }),
		);
		const key = body.querySelector<HTMLInputElement>('input[name="apiKey"]');
		if (key) key.value = "secret-token";
		await submit(body);
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("retries a failed save with the same request, without checking again", async () => {
		const { body, onSubmit, preview } = await mountForm(entry());
		onSubmit.mockRejectedValueOnce(new Error("Connection lost"));
		await submit(body);
		expect(body.querySelector("[role=alert]")?.textContent).toBe(
			"Connection lost",
		);
		await submit(body);
		expect(onSubmit).toHaveBeenCalledTimes(2);
		expect(preview).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[1]?.[0]).toEqual(onSubmit.mock.calls[0]?.[0]);
		expect(onSubmit.mock.calls[1]?.[0].requestId).toBe(
			"00000000-0000-4000-8000-000000000001",
		);
	});

	it("is usable again when the page returns from the provider", async () => {
		const { body, onSubmit } = await mountForm(entry());
		onSubmit.mockResolvedValueOnce(true);
		await submit(body);
		expect(button(body, "Opening provider…").disabled).toBe(true);
		expect(button(body, "Cancel").disabled).toBe(false);
		await act(async () => {
			window.dispatchEvent(
				Object.assign(new Event("pageshow"), { persisted: true }),
			);
		});
		expect(button(body, "Continue to sign in").disabled).toBe(false);
	});

	it("tells host extras when the form is locked", async () => {
		const seen: boolean[] = [];
		let finish: (value: boolean | undefined) => void = () => undefined;
		const body = await render(
			<ConnectorConnectionForm
				definition={entry()}
				requestId="00000000-0000-4000-8000-000000000001"
				preview={async () => found()}
				onClose={() => undefined}
				onSubmit={() =>
					new Promise((resolve) => {
						finish = resolve;
					})
				}
			>
				{(_, locked) => {
					seen.push(locked);
					return null;
				}}
			</ConnectorConnectionForm>,
		);
		expect(seen.at(-1)).toBe(false);
		await submit(body);
		expect(seen.at(-1)).toBe(true);
		await act(async () => finish(undefined));
		expect(seen.at(-1)).toBe(false);
		await act(async () =>
			root?.render(
				<ConnectorConnectionForm
					definition={entry()}
					requestId="00000000-0000-4000-8000-000000000001"
					saved
					preview={async () => found()}
					onClose={() => undefined}
					onSubmit={async () => undefined}
				>
					{(_, locked) => {
						seen.push(locked);
						return null;
					}}
				</ConnectorConnectionForm>,
			),
		);
		expect(seen.at(-1)).toBe(true);
	});

	it("keeps a declared first method of API key ahead of no sign-in", async () => {
		const { body } = await mountForm(
			entry({ authMethods: ["bearer", "none"] }),
		);
		const key = body.querySelector<HTMLInputElement>('input[name="apiKey"]');
		expect(key?.required).toBe(true);
		await act(async () =>
			button(body, "Connect without sign-in instead").click(),
		);
		expect(body.querySelector('input[name="apiKey"]')).toBeNull();
		expect(hasButton(body, "Use an API key instead")).toBe(true);
	});
});

const snapshotConnection = (
	status: string,
): Snapshot["connections"][number] => ({
	id: "c1",
	label: "Tracker",
	url: "https://mcp.tracker.example.test/mcp",
	transport: "http",
	status,
	authentication: "oauth",
	canManageAuthentication: true,
});

describe("UpstreamSignIn", () => {
	it("asks to replace sign-in only when there is sign-in to replace", async () => {
		const start = vi.fn(async () => ({ url: "about:blank" }));
		const body = await render(
			<UpstreamSignIn
				connection={snapshotConnection("authentication required")}
				api={{ startConnectionOAuth: start } as never}
				onClose={() => undefined}
			/>,
		);
		expect(body.textContent).not.toContain("replacing");
		act(() => root?.unmount());
		document.body.innerHTML = "";
		const again = await render(
			<UpstreamSignIn
				connection={snapshotConnection("authenticated")}
				api={{ startConnectionOAuth: start } as never}
				onClose={() => undefined}
			/>,
		);
		expect(again.textContent).toContain("replacing this connection's");
	});

	it("asks for the replacement when the server reports existing sign-in", async () => {
		const start = vi.fn(async () => {
			throw new Error(
				"Confirm replacement of this account's authentication before reconnecting",
			);
		});
		const body = await render(
			<UpstreamSignIn
				connection={snapshotConnection("authentication required")}
				api={{ startConnectionOAuth: start } as never}
				onClose={() => undefined}
			/>,
		);
		await submit(body);
		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({ confirmAccountReplacement: false }),
		);
		expect(body.textContent).toContain("replacing this connection's");
		expect(body.querySelector("[role=alert]")).toBeNull();
	});
});

describe("ConnectorCatalog cards", () => {
	it("says Needs sign-in until a browser sign-in connection is signed in", async () => {
		const tracker = entry({ featured: true });
		const props = {
			api: {
				connectorCatalog: vi.fn(async () => [tracker]),
				connectorInventory: vi.fn(async () => null),
				previewConnection: vi.fn(),
			} as never,
			scopeKey: "user",
			search: {},
			basePath: "/app/connections",
			onSearch: () => undefined,
			navigate: () => undefined,
			renderLink: ({ children }: { children: React.ReactNode }) => (
				<a href="/">{children}</a>
			),
			onCustom: () => undefined,
			onCreated: async () => undefined,
			connect: vi.fn(),
			renderConnectionForm: () => null,
		};
		const body = await render(
			<ConnectorCatalog
				{...props}
				connections={[snapshotConnection("authentication required")]}
			/>,
		);
		expect(body.textContent).toContain("Needs sign-in");
		expect(body.textContent).not.toContain("Connected");
		await act(async () =>
			root?.render(
				<ConnectorCatalog
					{...props}
					connections={[snapshotConnection("authenticated")]}
				/>,
			),
		);
		expect(body.textContent).toContain("Connected");
		expect(body.textContent).not.toContain("Needs sign-in");
	});

	it("hands a saved connection to the host and closes, with no notice of its own", async () => {
		const tracker = entry({ featured: true, authMethods: ["none"] });
		const created = {
			id: "c9",
			label: "Tracker",
			transport: "http" as const,
			authentication: "headers" as const,
			status: "reachable",
		};
		const onCreated = vi.fn(async () => undefined);
		const body = await render(
			<ConnectorCatalog
				api={
					{
						connectorCatalog: vi.fn(async () => [tracker]),
						previewConnection: vi.fn(async () =>
							found({ authentication: "headers", status: "reachable" }),
						),
					} as never
				}
				scopeKey="user"
				search={{}}
				basePath="/app/connections"
				onSearch={() => undefined}
				navigate={() => undefined}
				renderLink={({ children }) => <a href="/">{children}</a>}
				onCustom={() => undefined}
				onCreated={onCreated}
				connect={vi.fn(async () => created)}
				renderConnectionForm={(options) => (
					<ConnectorConnectionForm {...options} />
				)}
				connections={[]}
			/>,
		);
		await act(async () => button(body, "Connect").click());
		await submit(body);
		expect(onCreated).toHaveBeenCalledWith(created, expect.any(Function));
		expect(body.querySelector("form")).toBeNull();
		expect(body.textContent).not.toContain("was added");
		expect(body.textContent).not.toContain("Configure agent access");
	});

	const catalogProps = (tracker: ConnectorCatalogEntry) => ({
		search: {},
		basePath: "/app/connections",
		onSearch: () => undefined,
		navigate: () => undefined,
		renderLink: ({ children }: { children: React.ReactNode }) => (
			<a href="/">{children}</a>
		),
		onCustom: () => undefined,
		connections: [],
		api: {
			connectorCatalog: vi.fn(async () => [tracker]),
			previewConnection: vi.fn(async () => found()),
		} as never,
		renderConnectionForm: (
			options: Omit<ConnectorConnectionFormProps, "children">,
		) => <ConnectorConnectionForm {...options} />,
	});

	it("does not save when the scope changes while the address is checked", async () => {
		const tracker = entry({ featured: true, authMethods: ["oauth"] });
		let finish: (value: ConnectionPreview) => void = () => undefined;
		const base = catalogProps(tracker);
		const props = {
			...base,
			api: {
				connectorCatalog: vi.fn(async () => [tracker]),
				previewConnection: vi.fn(
					() =>
						new Promise<ConnectionPreview>((resolve) => {
							finish = resolve;
						}),
				),
			} as never,
			onCreated: vi.fn(async () => undefined),
			connect: vi.fn(),
		};
		const body = await render(<ConnectorCatalog {...props} scopeKey="one" />);
		await act(async () => button(body, "Connect").click());
		await submit(body);
		expect(button(body, "Checking…").disabled).toBe(true);
		await act(async () =>
			root?.render(<ConnectorCatalog {...props} scopeKey="two" />),
		);
		await act(async () => finish(found()));
		expect(props.connect).not.toHaveBeenCalled();
	});

	it("continues a saved connection after the provider page, without adding it again", async () => {
		const tracker = entry({ featured: true, authMethods: ["oauth"] });
		const created = {
			id: "c9",
			label: "Tracker",
			transport: "http" as const,
			authentication: "oauth" as const,
			status: "authentication required",
		};
		const props = {
			...catalogProps(tracker),
			onCreated: vi.fn(async () => true),
			connect: vi.fn(async () => created),
		};
		const body = await render(<ConnectorCatalog {...props} scopeKey="one" />);
		await act(async () => button(body, "Connect").click());
		await submit(body);
		expect(button(body, "Opening provider…").disabled).toBe(true);
		await act(async () => {
			window.dispatchEvent(
				Object.assign(new Event("pageshow"), { persisted: true }),
			);
		});
		// Back on the page, the form only resumes: the saved connection is not editable here.
		expect(body.textContent).toContain("Tracker is saved and needs sign-in");
		expect(hasButton(body, "Close")).toBe(true);
		await submit(body);
		expect(props.connect).toHaveBeenCalledTimes(1);
		expect(props.onCreated).toHaveBeenCalledTimes(2);
		expect(props.onCreated).toHaveBeenLastCalledWith(
			created,
			expect.any(Function),
		);
	});

	it("locks the key and method once saved, so a retry cannot change them", async () => {
		const tracker = entry({ featured: true, authMethods: ["bearer", "oauth"] });
		const created = {
			id: "c9",
			label: "Tracker",
			transport: "http" as const,
			authentication: "headers" as const,
			status: "reachable",
		};
		const props = {
			...catalogProps(tracker),
			onCreated: vi
				.fn<() => Promise<boolean | undefined>>()
				.mockRejectedValueOnce(new Error("Could not load connections"))
				.mockResolvedValue(undefined),
			connect: vi.fn(
				async (_input: ConnectConnectorInput, _fields: FormData) => created,
			),
		};
		const body = await render(<ConnectorCatalog {...props} scopeKey="one" />);
		await act(async () => button(body, "Connect").click());
		const key = body.querySelector<HTMLInputElement>('input[name="apiKey"]');
		if (key) key.value = "first-key";
		await submit(body);
		expect(body.querySelector("[role=alert]")?.textContent).toBe(
			"Could not load connections",
		);
		// Neither the key nor the method can change after the connection exists.
		expect(body.querySelector('input[name="apiKey"]')).toBeNull();
		expect(hasButton(body, "Use browser sign-in instead")).toBe(false);
		expect(body.textContent).toContain(
			"Change its settings or key from MCP connections",
		);
		await act(async () => button(body, "Finish").click());
		expect(props.connect).toHaveBeenCalledTimes(1);
		expect(props.connect.mock.calls[0]?.[0]).toMatchObject({
			authentication: "headers",
			headers: { Authorization: "Bearer first-key" },
		});
		expect(props.onCreated).toHaveBeenCalledTimes(2);
		expect(body.querySelector("form")).toBeNull();
	});

	it("does not leave for the provider after the person navigates away", async () => {
		const assign = vi
			.spyOn(window.location, "assign")
			.mockImplementation(() => undefined);
		const tracker = entry({ featured: true, authMethods: ["oauth"] });
		let started: (value: { url: string }) => void = () => undefined;
		const outcomes: string[] = [];
		const props = {
			...catalogProps(tracker),
			connect: vi.fn(async () => ({
				id: "c9",
				label: "Tracker",
				transport: "http" as const,
				authentication: "oauth" as const,
				status: "authentication required",
			})),
			// What the hosts do: start sign-in, guarded by the form's lifetime.
			onCreated: async (_: unknown, isCurrent: () => boolean) => {
				const outcome = await leaveForSignIn(
					() =>
						new Promise<{ url: string }>((resolve) => {
							started = resolve;
						}),
					isCurrent,
				);
				outcomes.push(outcome);
				return outcome === "left";
			},
		};
		const body = await render(<ConnectorCatalog {...props} scopeKey="one" />);
		await act(async () => button(body, "Connect").click());
		await submit(body);
		// Same workspace, another page of the catalog.
		await act(async () =>
			root?.render(
				<ConnectorCatalog {...props} scopeKey="one" connectorId="other" />,
			),
		);
		await act(async () =>
			started({ url: "https://provider.example.test/authorize" }),
		);
		expect(outcomes).toEqual(["stale"]);
		expect(assign).not.toHaveBeenCalled();
		assign.mockRestore();
	});
});

describe("leaveForSignIn", () => {
	it("stays when the page moved on while sign-in was starting", async () => {
		const assign = vi
			.spyOn(window.location, "assign")
			.mockImplementation(() => undefined);
		let current = true;
		const outcome = leaveForSignIn(
			async () => {
				current = false;
				return { url: "https://provider.example.test/authorize" };
			},
			() => current,
		);
		expect(await outcome).toBe("stale");
		expect(assign).not.toHaveBeenCalled();
		current = true;
		expect(
			await leaveForSignIn(
				async () => ({ url: "https://provider.example.test/authorize" }),
				() => current,
			),
		).toBe("left");
		expect(assign).toHaveBeenCalledWith(
			"https://provider.example.test/authorize",
		);
		expect(
			await leaveForSignIn(
				async () => {
					throw new Error("No client");
				},
				() => current,
			),
		).toBe("failed");
		assign.mockRestore();
	});
});

describe("refreshOnReturn", () => {
	it("reloads once when Back restores the page from the cache", () => {
		const reload = vi.fn(async () => undefined);
		refreshOnReturn(reload);
		window.dispatchEvent(
			Object.assign(new Event("pageshow"), { persisted: false }),
		);
		expect(reload).not.toHaveBeenCalled();
		refreshOnReturn(reload);
		window.dispatchEvent(
			Object.assign(new Event("pageshow"), { persisted: true }),
		);
		window.dispatchEvent(
			Object.assign(new Event("pageshow"), { persisted: true }),
		);
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
