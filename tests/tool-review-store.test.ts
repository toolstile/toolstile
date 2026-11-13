import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createToolReviewStore } from "../packages/api/src/tool-review-server";
import type { Pool } from "../packages/database/src/sql";
import { observeTool } from "../packages/gateway/src/index";
import { createAccountTestDatabase } from "./account-database";

const source = process.env.TEST_DATABASE_URL;
describe.skipIf(!source)("tool review store", () => {
	const _schema = `tool_review_${randomUUID().replaceAll("-", "")}`;
	let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>;
	let pool: Pool;
	const owner = randomUUID(),
		connectionId = randomUUID();
	const actor = { userId: owner, scopeId: owner, sessionId: "s" };
	let live = [
		observeTool({ name: "read", description: "Read", inputSchema: {} }),
		observeTool({ name: "write", description: "Write", inputSchema: {} }),
	];
	const waiting: string[][] = [];
	let reviewer = true;
	let store: ReturnType<typeof createToolReviewStore>;
	beforeAll(async () => {
		storage = await createAccountTestDatabase();
		pool = storage.pool;
		await pool.query(
			`insert into "user" (id, name, email, "emailVerified") values ($1, 'Owner', $2, true)`,
			[owner, `${owner}@example.test`],
		);
		await pool.query(
			`insert into connections (id, "ownerId", label, url, "encryptedHeaders")
			values ($1, $2, 'Docs', 'https://docs.example.test/mcp', 'x')`,
			[connectionId, owner],
		);
		store = createToolReviewStore({
			pool,
			fences: (actor) => [{ rank: 1, key: `user:${actor.userId}` }],
			tables: {
				settings: "tool_review_settings",
				definitions: "tool_definitions",
				reviews: "tool_reviews",
			},
			authorize: async () => ({ canReview: reviewer }),
			visible: async () => [{ id: connectionId, label: "Docs" }],
			baseline: async () => live,
			waiting: async (_scope, _connection, tools) => {
				waiting.push(tools);
			},
		});
	}, 30000);
	afterAll(async () => {
		await storage?.close();
	});
	const review = async () =>
		(await store.forConnections(pool, owner, [connectionId])).get(connectionId);
	it("is off until switched on, then accepts the live catalog as reviewed", async () => {
		expect(await review()).toBeUndefined();
		await store.services.setToolReview(actor, { connectionId, enabled: true });
		const current = await review();
		expect(Object.fromEntries(current?.reviewed ?? [])).toEqual({
			read: live[0].digest,
			write: live[1].digest,
		});
		const status = await store.services.toolReviewStatus(actor, connectionId);
		expect(status).toMatchObject({
			enabled: true,
			reviewedCount: 2,
			pending: [],
		});
	});
	it("records new and changed tools once, with the previous version for comparison", async () => {
		const changed = observeTool({
			name: "write",
			description: "Write and publish",
			inputSchema: {},
		});
		const added = observeTool({ name: "delete", inputSchema: {} });
		const current = await review();
		await current?.observe([changed, added]);
		await current?.observe([changed, added]);
		expect(waiting).toEqual([["write", "delete"]]);
		const status = await store.services.toolReviewStatus(actor, connectionId);
		const byName = Object.fromEntries(
			status.pending.map((change) => [change.name, change]),
		);
		expect(Object.keys(byName).sort()).toEqual(["delete", "write"]);
		expect(byName.write.previous?.digest).toBe(live[1].digest);
		expect(byName.write.previous?.snapshot).toContain('"Write"');
		expect(byName.write.snapshot).toContain("Write and publish");
		expect(byName.delete.previous).toBeUndefined();
		// A third version replaces the second; only the accepted one and the latest stay.
		const again = observeTool({
			name: "write",
			description: "Write, publish and share",
			inputSchema: {},
		});
		await current?.observe([again]);
		const { rows } = await pool.query(
			"select digest from tool_definitions where name='write'",
		);
		expect(rows.map((row) => row.digest).sort()).toEqual(
			[live[1].digest, again.digest].sort(),
		);
		await expect(
			store.services.acceptToolChanges(actor, {
				connectionId,
				tools: [{ name: "write", digest: changed.digest }],
			}),
		).rejects.toThrow(/changed again/);
		await store.services.acceptToolChanges(actor, {
			connectionId,
			tools: [{ name: "write", digest: again.digest }],
		});
		expect((await review())?.reviewed.get("write")).toBe(again.digest);
		const after = await store.services.toolReviewStatus(actor, connectionId);
		expect(after.pending.map((change) => change.name)).toEqual(["delete"]);
		const summary = await store.services.toolReviewSummary(actor);
		expect(summary.connections).toEqual([
			{ connectionId, label: "Docs", enabled: true, pending: 1 },
		]);
	});
	it("stores one version when a server lists a name twice", async () => {
		const current = await review();
		const first = observeTool({
			name: "twice",
			description: "A",
			inputSchema: {},
		});
		const second = observeTool({
			name: "twice",
			description: "B",
			inputSchema: {},
		});
		await current?.observe([first, second]);
		const { rows } = await pool.query(
			"select digest from tool_definitions where name='twice'",
		);
		expect(rows).toEqual([{ digest: second.digest }]);
	});
	it("lets only reviewers change review", async () => {
		reviewer = false;
		try {
			await expect(
				store.services.setToolReview(actor, { connectionId, enabled: false }),
			).rejects.toThrow(/access denied/);
		} finally {
			reviewer = true;
		}
	});
	it("forgets everything when switched off and stores nothing late", async () => {
		const current = await review();
		await store.services.setToolReview(actor, { connectionId, enabled: false });
		expect(await review()).toBeUndefined();
		await current?.observe([observeTool({ name: "late", inputSchema: {} })]);
		const { rows } = await pool.query(
			"select (select count(*) from tool_definitions) as d, (select count(*) from tool_reviews) as r",
		);
		expect(rows[0]).toEqual({ d: 0, r: 0 });
		// Switching on again takes a fresh baseline.
		live = [
			observeTool({ name: "read", description: "Read v2", inputSchema: {} }),
		];
		await store.services.setToolReview(actor, { connectionId, enabled: true });
		expect(Object.fromEntries((await review())?.reviewed ?? [])).toEqual({
			read: live[0].digest,
		});
	});
});
