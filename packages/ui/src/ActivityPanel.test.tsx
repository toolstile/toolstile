import type { ManagementClient } from "@toolstile/api/client";
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

import { ActivityPanel, type ActivityView } from "./ActivityPanel";

type Entry = Snapshot["activity"][number];
const entry = (
	id: string,
	patch: Partial<Entry> = {},
	minutesAgo = Number(id.replace(/\D/g, "")) || 0,
): Entry => ({
	id,
	agent: "Claude Code",
	connection: "deepwiki.com",
	origin: "agent",
	method: "tools/call",
	target: "ask_wiki_question",
	outcome: "forwarded",
	durationMs: 120,
	createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
	...patch,
});
const dashboard = (id: string) =>
	entry(id, {
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
function render(activity: Entry[], view: ActivityView = {}) {
	return renderToStaticMarkup(
		<ActivityPanel
			data={snapshot(activity)}
			api={{} as ManagementClient}
			view={view}
			onViewChange={() => undefined}
			onNavigate={() => undefined}
		/>,
	);
}
/** The segment buttons in a filter group, as "label count" pairs. */
function segments(html: string, label: string) {
	const group = html.match(
		new RegExp(`<nav aria-label="${label}">(.*?)</nav>`),
	)?.[1];
	return [
		...(group ?? "").matchAll(/<button[^>]*>([^<]*)<span>(\d+)<\/span>/g),
	].map(([, name, count]) => `${name} ${count}`);
}
const mixed = [
	entry("a1"),
	dashboard("d2"),
	entry("a3", { outcome: "denied", target: "write_page" }),
	dashboard("d4"),
	dashboard("d5"),
];

describe("activity panel", () => {
	it("hides dashboard requests by default and counts what it shows", () => {
		const html = render(mixed);
		expect(segments(html, "Source")).toEqual(["Agents 2", "All 5"]);
		expect(segments(html, "Outcome")).toEqual([
			"All 2",
			"Forwarded 1",
			"Denied 1",
			"Errors 0",
			"Needs approval 0",
		]);
		expect(html).not.toContain(">Dashboard<");
		expect(html).toContain("Showing all 2 recent requests");
		expect(html).toContain("3 dashboard checks hidden");
		expect(html).toContain(">Show all</button>");
		// The summary covers the agents' requests only.
		expect(html).toContain('aria-label="Across the 2 most recent requests"');
	});
	it("shows every source when asked", () => {
		const html = render(mixed, { source: "all" });
		expect(segments(html, "Outcome")[0]).toBe("All 5");
		expect(html).toContain(">Dashboard<");
		expect(html).toContain("Showing all 5 recent requests");
		expect(html).not.toContain("dashboard checks hidden");
	});
	it("says no agent has made a request when only dashboard checks exist", () => {
		const html = render([dashboard("d1"), dashboard("d2")]);
		expect(html).toContain("No agent has made a request yet");
		expect(html).toContain(">Show all</button>");
		expect(html).not.toContain("<table");
	});
	it("marks a linked request and opens the page that holds it", () => {
		const activity = Array.from({ length: 60 }, (_, index) =>
			entry(`a${index}`, { target: `tool_${index}` }),
		);
		const html = render(activity, { request: "a30" });
		expect(html).toMatch(/<tr aria-current="true">.*?tool_30</);
		expect(html.match(/aria-current="true"/g)).toHaveLength(1);
		// The 26th to 50th requests (a25 to a49) are page 2.
		expect(html).toContain("Page 2 of 3");
		expect(html).toContain("tool_25<");
		expect(html).not.toContain("tool_24<");
		// An explicit page wins.
		const first = render(activity, { request: "a30", page: 1 });
		expect(first).not.toContain('aria-current="true"');
	});
	it("shows a linked dashboard request with every source", () => {
		const html = render(mixed, { request: "d4" });
		expect(html).toContain('<tr aria-current="true">');
		expect(segments(html, "Source")).toEqual(["Agents 2", "All 5"]);
		expect(html).toMatch(/<button type="button" aria-current="page">All/);
	});
	it("renders normally when the linked request is not loaded", () => {
		const html = render(mixed, { request: "missing" });
		expect(html).not.toContain('aria-current="true"');
		expect(html).toContain("Showing all 2 recent requests");
		expect(html).toContain(
			"The linked request is older than the recent requests",
		);
		expect(render(mixed)).not.toContain("The linked request is older");
	});
});
