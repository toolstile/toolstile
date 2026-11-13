import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PoolClient } from "./sql";

type Client = Pick<PoolClient, "query" | "release">;
type Migration = ReturnType<typeof readMigrationFiles>[number];

/** First line of a migration whose statements build indexes without blocking
 * writes. Such a migration may contain only `CREATE [UNIQUE] INDEX CONCURRENTLY
 * IF NOT EXISTS "name" ...` statements; it runs outside a transaction and is
 * journaled only after every index is built and valid. */
const CONCURRENT_INDEX_MARKER = "-- migrate:concurrent-index";
const LOCK_KEY = 7194311;
/** Quoted index name, then the optionally schema-qualified quoted target table. */
const indexStatement =
	/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"\s+ON\s+(?:ONLY\s+)?(?:"([^"]+)"\.)?"([^"]+)"/i;
const withoutComments = (sql: string) =>
	sql
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.trim();

function isConcurrentIndexMigration(migration: Pick<Migration, "sql">) {
	return migration.sql[0]?.trimStart().startsWith(CONCURRENT_INDEX_MARKER);
}

type IndexTarget = {
	name: string;
	schema: string | undefined;
	table: string;
	statement: string;
};
/** The indexes a concurrent-index migration builds and the table each belongs
 * to; any other statement is refused. */
function concurrentIndexes(migration: Pick<Migration, "sql">): IndexTarget[] {
	return migration.sql
		.map(withoutComments)
		.filter(Boolean)
		.map((statement) => {
			const match = indexStatement.exec(statement);
			if (!match)
				throw new Error(
					"A concurrent-index migration may only create quoted indexes concurrently on a quoted table",
				);
			const [, name, schema, table] = match;
			return { name, schema, table, statement };
		});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A session advisory lock taken by polling, so a waiting migrator never holds a
 * snapshot that a concurrent index build would have to wait for. */
async function lock(client: Client) {
	for (;;) {
		const {
			rows: [row],
		} = await client.query<{ locked: boolean }>(
			"SELECT pg_try_advisory_lock($1) AS locked",
			[LOCK_KEY],
		);
		if (row?.locked) return;
		await sleep(250);
	}
}

async function applied(client: Client, migration: Migration) {
	const {
		rows: [row],
	} = await client.query<{ hash: string }>(
		"SELECT hash FROM __toolstile_migrations WHERE id=$1",
		[migration.folderMillis],
	);
	if (row && row.hash !== migration.hash)
		throw new Error("An applied Postgres migration was changed");
	return !!row;
}

async function record(client: Client, migration: Migration) {
	await client.query(
		"INSERT INTO __toolstile_migrations(id,hash) VALUES($1,$2)",
		[migration.folderMillis, migration.hash],
	);
}

/** Ordinary migrations: each run of consecutive pending ones commits atomically. */
async function applyTransactional(client: Client, migrations: Migration[]) {
	if (!migrations.length) return;
	await client.query("BEGIN");
	try {
		for (const migration of migrations) {
			if (await applied(client, migration)) continue;
			for (const query of migration.sql)
				if (query.trim()) await client.query(query);
			await record(client, migration);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

const isLockTimeout = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "55P03";
const notSupported = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "0A000";

/** The state of the relation named like `target` in the target table's schema:
 * absent, or an index on exactly that table (valid or not). Any other relation
 * of that name, including an index on another table, fails the migration so it
 * is never accepted in place of the intended index nor dropped. */
async function indexValidity(client: Client, target: IndexTarget) {
	const {
		rows: [row],
	} = await client.query<{
		kind: string;
		valid: boolean | null;
		tableSchema: string | null;
		table: string | null;
		expectedSchema: string;
	}>(
		`SELECT c.relkind AS kind, i.indisvalid AS valid,
		 tn.nspname AS "tableSchema", t.relname AS "table",
		 coalesce($2, current_schema()) AS "expectedSchema"
		 FROM pg_class c
		 JOIN pg_namespace n ON n.oid=c.relnamespace
		 LEFT JOIN pg_index i ON i.indexrelid=c.oid
		 LEFT JOIN pg_class t ON t.oid=i.indrelid
		 LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace
		 WHERE c.relname=$1 AND n.nspname=coalesce($2, current_schema())`,
		[target.name, target.schema ?? null],
	);
	if (!row) return undefined;
	if (
		row.valid === null ||
		row.table !== target.table ||
		row.tableSchema !== row.expectedSchema
	)
		throw new Error(
			`Relation "${target.name}" already exists and is not an index on "${row.expectedSchema}"."${target.table}"; resolve the name collision before migrating`,
		);
	return row.valid;
}

/** Builds each index without blocking writes. An interrupted build leaves an
 * INVALID index behind; it is dropped and rebuilt rather than treated as present.
 * Lock waits are bounded and retried; the journal row is written last. */
async function applyConcurrentIndexes(
	client: Client,
	migration: Migration,
	options: { lockTimeoutMs: number; attempts: number },
) {
	if (await applied(client, migration)) return;
	const indexes = concurrentIndexes(migration);
	await client.query(`SET lock_timeout = ${Math.floor(options.lockTimeoutMs)}`);
	try {
		for (const target of indexes) {
			const { name, schema, statement } = target;
			const qualified = schema ? `"${schema}"."${name}"` : `"${name}"`;
			for (let attempt = 1; ; attempt++) {
				try {
					if ((await indexValidity(client, target)) === false)
						await client.query(
							`DROP INDEX CONCURRENTLY IF EXISTS ${qualified}`,
						);
					try {
						await client.query(statement);
					} catch (error) {
						// An engine without concurrent builds takes the ordinary lock instead.
						if (!notSupported(error)) throw error;
						await client.query(statement.replace(/\s+CONCURRENTLY\s+/i, " "));
					}
					if ((await indexValidity(client, target)) !== true)
						throw new Error(`Index "${name}" was not built`);
					break;
				} catch (error) {
					if (!isLockTimeout(error) || attempt >= options.attempts) throw error;
					await sleep(1000 * attempt);
				}
			}
		}
	} finally {
		await client.query("RESET lock_timeout");
	}
	await record(client, migration);
}

/** Serialize schema changes and verify the immutable journal. Ordinary migrations
 * apply in transactions; concurrent-index migrations build outside one. */
export async function migrateDatabaseWithLock(
	pool: { connect(): Promise<Client> },
	config: { migrationsFolder: string },
	options: { lockTimeoutMs?: number; attempts?: number } = {},
) {
	const migrations = readMigrationFiles(config);
	const client = await pool.connect();
	try {
		await lock(client);
		try {
			await client.query(
				'CREATE TABLE IF NOT EXISTS __toolstile_migrations(id bigint PRIMARY KEY,hash text NOT NULL,"appliedAt" timestamptz NOT NULL DEFAULT clock_timestamp())',
			);
			let batch: Migration[] = [];
			for (const migration of migrations) {
				if (!isConcurrentIndexMigration(migration)) {
					batch.push(migration);
					continue;
				}
				await applyTransactional(client, batch);
				batch = [];
				await applyConcurrentIndexes(client, migration, {
					lockTimeoutMs: options.lockTimeoutMs ?? 5000,
					attempts: options.attempts ?? 5,
				});
			}
			await applyTransactional(client, batch);
		} finally {
			await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
		}
	} finally {
		client.release();
	}
}
