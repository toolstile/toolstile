import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/database/src/index";
import { migrateDatabaseWithLock } from "../packages/database/src/migrate";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** Writes a drizzle-format migration folder from ordered SQL files. */
function folder(files: string[]) {
	const root = mkdtempSync(join(tmpdir(), "toolstile-migrate-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "meta"));
	const entries = files.map((sql, idx) => {
		const tag = `000${idx}_fixture`;
		writeFileSync(join(root, `${tag}.sql`), sql);
		return { idx, version: "7", when: 1_000 + idx, tag, breakpoints: true };
	});
	writeFileSync(
		join(root, "meta", "_journal.json"),
		JSON.stringify({ version: "7", dialect: "postgresql", entries }),
	);
	return { migrationsFolder: root };
}

const engines: [string, () => Promise<string>][] = [
	[
		"PGlite",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "toolstile-migrate-db-"));
			cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
			return join(directory, "pglite");
		},
	],
];
const serverUrl = process.env.TEST_DATABASE_URL;
if (serverUrl?.startsWith("postgres"))
	engines.push([
		"PostgreSQL",
		async () => {
			const name = `migrate_${randomUUID().replaceAll("-", "")}`;
			const admin = new pg.Pool({ connectionString: serverUrl });
			await admin.query(`CREATE DATABASE "${name}"`);
			cleanup.push(async () => {
				await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
				await admin.end();
			});
			const url = new URL(serverUrl);
			url.pathname = `/${name}`;
			return url.href;
		},
	]);

const ordinary = `CREATE TABLE items(id integer PRIMARY KEY, code integer NOT NULL);
--> statement-breakpoint
INSERT INTO items VALUES (1, 1), (2, 2);`;
const concurrent = `-- migrate:concurrent-index
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "items_code" ON "items" USING btree ("code");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "items_partial" ON "items" ("id") WHERE "code" > 1;`;

// Each case opens a fresh embedded or server database; allow for a loaded host.
describe.each(engines)(
	"migrations on %s",
	{ timeout: 30_000 },
	(_engine, location) => {
		async function open() {
			const { pool } = openDatabase(await location());
			cleanup.push(() => pool.end());
			return pool;
		}
		const validity = async (pool: Awaited<ReturnType<typeof open>>) =>
			(
				await pool.query<{ name: string; valid: boolean }>(
					`SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i
				 JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('items_code','items_partial') ORDER BY 1`,
				)
			).rows;
		const journal = async (pool: Awaited<ReturnType<typeof open>>) =>
			(
				await pool.query<{ id: number }>(
					"SELECT id FROM __toolstile_migrations ORDER BY id",
				)
			).rows.map((row) => Number(row.id));

		it("builds concurrent indexes on fresh and repeated runs", async () => {
			const pool = await open();
			const config = folder([ordinary, concurrent]);
			await migrateDatabaseWithLock(pool, config);
			await migrateDatabaseWithLock(pool, config);
			expect(await validity(pool)).toEqual([
				{ name: "items_code", valid: true },
				{ name: "items_partial", valid: true },
			]);
			expect(await journal(pool)).toEqual([1000, 1001]);
		});

		it("drops and rebuilds an index an interrupted build left INVALID", async () => {
			const pool = await open();
			await migrateDatabaseWithLock(pool, folder([ordinary]));
			await pool.query("INSERT INTO items VALUES (3, 1)");
			// A failed concurrent build leaves its index behind, marked invalid.
			await expect(
				pool.query(
					'CREATE UNIQUE INDEX CONCURRENTLY "items_code" ON items(code)',
				),
			).rejects.toThrow();
			expect(await validity(pool)).toEqual([
				{ name: "items_code", valid: false },
			]);
			await expect(
				migrateDatabaseWithLock(pool, folder([ordinary, concurrent])),
			).rejects.toThrow();
			expect(await journal(pool)).toEqual([1000]);
			await pool.query("DELETE FROM items WHERE id=3");
			await migrateDatabaseWithLock(pool, folder([ordinary, concurrent]));
			expect(await validity(pool)).toEqual([
				{ name: "items_code", valid: true },
				{ name: "items_partial", valid: true },
			]);
			expect(await journal(pool)).toEqual([1000, 1001]);
		});

		it.each([
			["valid", false],
			["invalid", true],
		])(
			"refuses a %s same-named index on another table and never drops it",
			async (_state, invalid) => {
				const pool = await open();
				await migrateDatabaseWithLock(pool, folder([ordinary]));
				await pool.query("CREATE TABLE other(id integer, code integer)");
				if (invalid) {
					await pool.query("INSERT INTO other VALUES (1, 1), (2, 1)");
					await expect(
						pool.query(
							'CREATE UNIQUE INDEX CONCURRENTLY "items_code" ON other(code)',
						),
					).rejects.toThrow();
				} else await pool.query('CREATE INDEX "items_code" ON other(code)');
				const owner = async () =>
					(
						await pool.query<{ table: string; valid: boolean }>(
							`SELECT t.relname AS "table", i.indisvalid AS valid FROM pg_index i
					 JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
					 WHERE c.relname='items_code'`,
						)
					).rows;
				expect(await owner()).toEqual([{ table: "other", valid: !invalid }]);
				await expect(
					migrateDatabaseWithLock(pool, folder([ordinary, concurrent])),
				).rejects.toThrow('is not an index on "public"."items"');
				expect(await owner()).toEqual([{ table: "other", valid: !invalid }]);
				expect(await journal(pool)).toEqual([1000]);
			},
		);
		it("keeps ordinary migrations atomic and refuses other concurrent statements", async () => {
			const pool = await open();
			await expect(
				migrateDatabaseWithLock(
					pool,
					folder([
						ordinary,
						"CREATE TABLE partial(id integer);\n--> statement-breakpoint\nSELECT 1/0;",
					]),
				),
			).rejects.toThrow();
			expect(
				(await pool.query("SELECT to_regclass('items') AS t")).rows[0].t,
			).toBeNull();
			await expect(
				migrateDatabaseWithLock(
					pool,
					folder([`-- migrate:concurrent-index\nDROP TABLE "items";`]),
				),
			).rejects.toThrow("may only create quoted indexes concurrently");
		});
	},
);
