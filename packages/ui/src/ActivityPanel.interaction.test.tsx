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

import { ActivityPanel, type ActivityView } from "./ActivityPanel";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Entry = Snapshot["activity"][number];
const entry = (id: string, minutesAgo: number, patch: Partial<Entry> = {}) => ({
	id,
	agent: "Claude Code",
	connection: "deepwiki.com",
	origin: "agent" as const,
	method: "tools/call",
	target: `tool_${id}`,
	outcome: "forwarded",
	durationMs: 120,
	createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
	...patch,
});
const dashboard = (id: string, minutesAgo: number) =>
	entry(id, minutesAgo, {
		agent: "Dashboard",
		origin: "dashboard",
		method: "tools/list",
		target: null,
	});
const snapshot = (activity: Entry[]) =>
	({
		connections: [],
		agents: [],
		grants: [],
		allAgentGrants: [],
		activity,
	}) as unknown as Snapshot;

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
});
async function mount(
	activity: Entry[],
	view: ActivityView,
	activityRequest: ManagementClient["activityRequest"],
) {
	const api = { activityRequest } as unknown as ManagementClient;
	const render = (next: ActivityView) =>
		root?.render(
			<ActivityPanel
				data={snapshot(activity)}
				api={api}
				view={next}
				onViewChange={() => undefined}
				onNavigate={() => undefined}
			/>,
		);
	container = document.createElement("div");
	root = createRoot(container);
	await act(async () => render(view));
	return async (next: ActivityView) => {
		await act(async () => render(next));
	};
}
const current = () =>
	container.querySelector('tr[aria-current="true"]')?.textContent ?? null;
const note = "The linked request is no longer available.";

describe("activity panel linked request lookup", () => {
	it("reads a linked request older than the loaded ones once and marks it", async () => {
		const scroll = vi.fn();
		Element.prototype.scrollIntoView = scroll;
		const old = entry("old", 600);
		const lookup = vi.fn(async () => old);
		const rerender = await mount(
			[entry("a1", 1), entry("a2", 2)],
			{ request: "old" },
			lookup,
		);
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(lookup).toHaveBeenCalledWith({ id: "old" });
		expect(current()).toContain("tool_old");
		expect(scroll).toHaveBeenCalledTimes(1);
		// Newest first: the older row follows the loaded ones, and counts include it.
		const targets = [...container.querySelectorAll("tbody code")].map(
			(cell) => cell.textContent,
		);
		expect(targets.at(-1)).toContain("tool_old");
		expect(container.textContent).toContain("Showing all 3 recent requests");
		expect(container.textContent).not.toContain(note);
		await rerender({ request: "old" });
		expect(lookup).toHaveBeenCalledTimes(1);
	});
	it("shows a fetched dashboard request with every source", async () => {
		const lookup = vi.fn(async () => dashboard("check", 600));
		await mount([entry("a1", 1)], { request: "check" }, lookup);
		expect(current()).toContain("Dashboard");
		expect(
			container.querySelector('nav[aria-label="Source"] [aria-current="page"]')
				?.textContent,
		).toMatch(/^All/);
	});
	it("says a linked request is no longer available, also with only dashboard checks", async () => {
		const lookup = vi.fn(async () => null);
		await mount(
			[dashboard("d1", 1), dashboard("d2", 2)],
			{ request: "gone" },
			lookup,
		);
		expect(container.textContent).toContain("No agent has made a request yet");
		expect(container.querySelector('[role="status"]')?.textContent).toBe(note);
		expect(current()).toBeNull();
	});
	it("offers a retry when the lookup fails, also with no requests at all", async () => {
		let offline = true;
		const lookup = vi.fn(async () => {
			if (offline) throw new Error("offline");
			return null;
		});
		await mount([], { request: "gone" }, lookup);
		expect(container.textContent).toContain("Go to connections");
		expect(container.textContent).toContain(
			"The linked request could not be loaded.",
		);
		expect(container.textContent).not.toContain(note);
		offline = false;
		const retry = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry",
		);
		await act(async () => retry?.click());
		expect(lookup).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain(note);
	});
	it("reads again with the client of another workspace and drops the earlier answer", async () => {
		const first = vi.fn(async () => null);
		const second = vi.fn(async () => entry("old", 600));
		const render = (activityRequest: ManagementClient["activityRequest"]) =>
			act(async () =>
				root?.render(
					<ActivityPanel
						data={snapshot([entry("a1", 1)])}
						api={{ activityRequest } as unknown as ManagementClient}
						view={{ request: "old" }}
						onViewChange={() => undefined}
						onNavigate={() => undefined}
					/>,
				),
			);
		container = document.createElement("div");
		root = createRoot(container);
		await render(first);
		expect(container.textContent).toContain(note);
		await render(second);
		expect(second).toHaveBeenCalledTimes(1);
		expect(container.textContent).not.toContain(note);
		expect(current()).toContain("tool_old");
	});
	it("ignores an answer for a request that is no longer linked", async () => {
		let answer: (value: Entry | null) => void = () => undefined;
		const lookup = vi.fn(
			(input: { id: string }) =>
				new Promise<Entry | null>((resolve) => {
					if (input.id === "first") answer = resolve;
					else resolve(null);
				}),
		);
		const rerender = await mount(
			[entry("a1", 1)],
			{ request: "first" },
			lookup,
		);
		await rerender({ request: "second" });
		await act(async () => answer(entry("first", 600)));
		expect(current()).toBeNull();
		expect(container.textContent).not.toContain("tool_first");
		expect(container.textContent).toContain(note);
	});
	it("waits for the scope to load before reading a linked request", async () => {
		const lookup = vi.fn(async () => entry("old", 600));
		const render = (pending: boolean) =>
			act(async () =>
				root?.render(
					<ActivityPanel
						data={snapshot([entry("a1", 1)])}
						api={api}
						pending={pending}
						view={{ request: "old" }}
						onViewChange={() => undefined}
						onNavigate={() => undefined}
					/>,
				),
			);
		const api = { activityRequest: lookup } as unknown as ManagementClient;
		container = document.createElement("div");
		root = createRoot(container);
		await render(true);
		expect(lookup).not.toHaveBeenCalled();
		expect(container.textContent).not.toContain(note);
		await render(false);
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(current()).toContain("tool_old");
	});
	it("does not highlight a linked row left over from the previous scope", async () => {
		const lookup = vi.fn(async () => null);
		const api = { activityRequest: lookup } as unknown as ManagementClient;
		const scroll = vi.fn();
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = scroll;
		const render = (pending: boolean) =>
			act(async () =>
				root?.render(
					<ActivityPanel
						data={snapshot([entry("a1", 1)])}
						api={api}
						pending={pending}
						view={{ request: "a1" }}
						onViewChange={() => undefined}
						onNavigate={() => undefined}
					/>,
				),
			);
		container = document.createElement("div");
		root = createRoot(container);
		try {
			await render(true);
			expect(current()).toBeNull();
			expect(scroll).not.toHaveBeenCalled();
			expect(lookup).not.toHaveBeenCalled();
			await render(false);
			expect(current()).toContain("tool_a1");
			expect(scroll).toHaveBeenCalledTimes(1);
		} finally {
			Element.prototype.scrollIntoView = original;
		}
	});
	it("does not look up a loaded request or when none is linked", async () => {
		const lookup = vi.fn(async () => null);
		const rerender = await mount([entry("a1", 1)], {}, lookup);
		await rerender({ request: "a1" });
		expect(lookup).not.toHaveBeenCalled();
		expect(current()).toContain("tool_a1");
		expect(container.textContent).not.toContain(note);
	});
});
