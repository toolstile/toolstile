import { expect, test } from "vitest";
import {
	openDatabase,
	postgresStatement,
} from "../packages/database/src/index";

test("Postgres placeholders preserve JSON operators and literal text", () => {
	expect(
		postgresStatement(
			"SELECT '$2' AS literal,$2 AS second,$1 AS first,data ? 'key'",
			["a", "b"],
		),
	).toEqual({
		sql: "SELECT '$2' AS literal,$2 AS second,$1 AS first,data ? 'key'",
		params: ["a", "b"],
	});
});
test("raw SQL reports parent affected rows independently of cascading deletes", async () => {
	const { pool } = openDatabase(":memory:");
	try {
		await pool.query("CREATE TABLE parent(id TEXT PRIMARY KEY)");
		await pool.query(
			"CREATE TABLE child(id TEXT REFERENCES parent(id) ON DELETE CASCADE)",
		);
		await pool.query("INSERT INTO parent VALUES('one')");
		await pool.query("INSERT INTO child VALUES('one'),('one')");
		expect(
			(await pool.query("DELETE FROM parent WHERE id='one'")).rowCount,
		).toBe(1);
		expect((await pool.query("SELECT * FROM child")).rowCount).toBe(0);
	} finally {
		await pool.end();
	}
}, 30_000);

test("PGlite client release rolls back before another request acquires ownership", async () => {
	const { pool } = openDatabase(":memory:");
	try {
		await pool.query("CREATE TABLE released_client(id text PRIMARY KEY)");
		const client = await pool.connect();
		await client.query("BEGIN");
		await client.query("INSERT INTO released_client VALUES('discarded')");
		const outside = pool.query("INSERT INTO released_client VALUES('kept')");
		client.release();
		await outside;
		expect((await pool.query("SELECT * FROM released_client")).rows).toEqual([
			{ id: "kept" },
		]);
		await expect(client.query("SELECT 1")).rejects.toThrow("released");
	} finally {
		await pool.end();
	}
});
test("PGlite raw values preserve duplicate joined output column names", async () => {
	const { pool } = openDatabase(":memory:");
	try {
		const result = await pool.raw(
			"SELECT a.id,b.id FROM (VALUES('first')) a(id) CROSS JOIN (VALUES('second')) b(id)",
		);
		expect(result.values).toEqual([["first", "second"]]);
	} finally {
		await pool.end();
	}
});

test("transaction hooks share their connection without leaking it into concurrent requests", async () => {
	const { db, pool } = openDatabase(":memory:");
	try {
		await pool.query("create table hooks(id text primary key)");
		let entered!: () => void, resume!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const transaction = db.transaction(async () => {
			await pool.query("insert into hooks values('discarded')");
			expect((await pool.raw("select id from hooks")).values).toEqual([
				["discarded"],
			]);
			entered();
			await gate;
			throw new Error("Synthetic rollback");
		});
		await ready;
		const outside = pool.query("insert into hooks values('kept')");
		resume();
		await expect(transaction).rejects.toThrow("Synthetic rollback");
		await outside;
		expect((await pool.query("select id from hooks")).rows).toEqual([
			{ id: "kept" },
		]);
	} finally {
		await pool.end();
	}
});
