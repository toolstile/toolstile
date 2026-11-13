import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	applyInventories,
	discoverAll,
	discoverInventory,
	discoveryPlan,
	discoveryTokenVariable,
	readCatalogFile,
	writeCatalogFile,
} from "../apps/web/scripts/catalog-sync";
import {
	type CatalogEntry,
	type ConnectorInventory,
	catalogEntry,
} from "../packages/api/src/connectors";
import { startFixture } from "./fixture";

const definition = (
	slug: string,
	patch: Partial<CatalogEntry> = {},
): CatalogEntry =>
	catalogEntry.parse({
		slug,
		featured: false,
		listed: true,
		name: `Example ${slug}`,
		publisher: "Example",
		description: "A synthetic catalog entry.",
		categories: ["development"],
		keywords: [],
		capabilities: [],
		documentation: "https://docs.example.test/",
		endpoint: `https://${slug}.example.test/mcp`,
		authMethods: ["none"],
		requirements: "",
		fields: [],
		...patch,
	});
const inventory = (
	observedAt: string,
	tool = "search",
	source: ConnectorInventory["source"] = "discovery",
): ConnectorInventory => ({
	observedAt,
	source,
	tools: [{ name: tool, description: "Find things" }],
	resources: [],
	prompts: [],
});

describe("discovery into the bundled v1 snapshot", () => {
	let fixture: Awaited<ReturnType<typeof startFixture>>;
	beforeAll(async () => {
		fixture = await startFixture();
	});
	afterAll(async () => {
		await fixture?.close();
	});
	it("lists a server with the gateway client and keeps only listing fields", async () => {
		const entry = { ...definition("fixture"), endpoint: fixture.url };
		const result = await discoverInventory(
			entry,
			{},
			{
				validateDestination: async () => {},
				now: () => new Date("2026-01-02T03:04:05.000Z"),
			},
		);
		expect(result).toEqual({
			observedAt: "2026-01-02T03:04:05.000Z",
			source: "discovery",
			tools: ["read_docs", "write_note", "delete_note"].map((name) => ({
				name,
				description: `Local fixture: ${name}`,
			})),
			resources: [{ uri: "test://readme", name: "Fixture readme" }],
			prompts: [{ name: "review", description: "A local fixture prompt" }],
		});
		// Listing never calls a tool.
		expect(fixture.calls()).toBe(0);
	});
	it("reports each failure on its own and never returns partial results", async () => {
		const good = { ...definition("good"), endpoint: fixture.url };
		const down = { ...definition("down"), endpoint: "http://127.0.0.1:9/mcp" };
		const results = await discoverAll(
			[
				{ entry: good, headers: {} },
				{ entry: down, headers: {} },
			],
			{ validateDestination: async () => {}, timeoutMs: 5_000 },
		);
		expect(results.map((result) => [result.id, "inventory" in result])).toEqual(
			[
				["down", false],
				["good", true],
			],
		);
		expect(results[0]).toMatchObject({ error: expect.any(String) });
	});
	it("plans only sign-in-free entries, or bearer entries with a token from the environment", () => {
		const open = definition("open");
		const keyed = definition("keyed-app", { authMethods: ["bearer", "oauth"] });
		const configured = definition("configured", {
			fields: [
				{
					name: "region",
					label: "Region",
					help: "",
					kind: "text",
					required: true,
				},
			],
		});
		expect(discoveryTokenVariable("keyed-app")).toBe(
			"CATALOG_DISCOVER_TOKEN_KEYED_APP",
		);
		expect(discoveryPlan(open, {})).toEqual({ entry: open, headers: {} });
		expect(discoveryPlan(keyed, {})).toMatchObject({ skip: "needs sign-in" });
		expect(
			discoveryPlan(keyed, { CATALOG_DISCOVER_TOKEN_KEYED_APP: "synthetic" }),
		).toEqual({ entry: keyed, headers: { Authorization: "Bearer synthetic" } });
		expect(discoveryPlan(configured, {})).toMatchObject({
			skip: "needs configuration",
		});
	});
	it("writes tool snapshots by slug into a validated snapshot, keeping other entries", async () => {
		const directory = await mkdtemp(join(tmpdir(), "catalog-"));
		try {
			const file = pathToFileURL(join(directory, "v1.json"));
			const a = {
				...definition("alpha"),
				toolSnapshot: inventory("2026-01-01T00:00:00.000Z", "old"),
			};
			const b = definition("beta");
			await writeCatalogFile(
				{
					version: 1,
					generatedAt: "2026-01-01T00:00:00.000Z",
					entries: [a, b],
				},
				file,
			);
			const { raw, entries } = await readCatalogFile(file);
			expect(entries.map((entry) => entry.slug)).toEqual(["alpha", "beta"]);
			const updates = new Map([
				["alpha", inventory("2026-02-01T00:00:00.000Z", "new")],
			]);
			await writeCatalogFile(applyInventories(raw, updates), file);
			const written = JSON.parse(await readFile(file, "utf8"));
			expect(written.generatedAt).toBe("2026-02-01T00:00:00.000Z");
			expect(written.entries[0].toolSnapshot.tools[0].name).toBe("new");
			expect(written.entries[1]).toEqual(JSON.parse(JSON.stringify(b)));
			// Invalid data is never written.
			const before = await readFile(file, "utf8");
			await expect(
				writeCatalogFile(
					{
						...written,
						entries: [
							{ ...written.entries[0], registeredClient: { env: "X" } },
						],
					},
					file,
				),
			).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe(before);
			await writeFile(file, before);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
