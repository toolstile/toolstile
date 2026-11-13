import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import pg from "pg";
import { ownedPGlite } from "./pglite";
import { baseSchema } from "./schema";
import type { Pool, PoolClient } from "./sql";
import { databaseIdentity, heldConnection, transaction } from "./transaction";

export * from "./columns";
export { migrateDatabaseWithLock } from "./migrate";
export * from "./namespaces";
export * from "./schema";
export type DatabasePoolOptions = Pick<
	pg.PoolConfig,
	| "max"
	| "connectionTimeoutMillis"
	| "statement_timeout"
	| "idle_in_transaction_session_timeout"
	| "application_name"
> & { schema?: Record<string, unknown> };
const dialect = new PgDialect();
export function postgresStatement(
	sql: string,
	params: readonly unknown[] = [],
) {
	let index = 0;
	if (/\$\d+/.test(sql))
		return {
			sql,
			params: params.map((value) =>
				Array.isArray(value) ? JSON.stringify(value) : value,
			),
		};
	return {
		sql: sql.replace(
			/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?/g,
			(token) => (token === "?" ? `$${++index}` : token),
		),
		params: params.map((value) =>
			Array.isArray(value) ? JSON.stringify(value) : value,
		),
	};
}
export function openDatabase(url: string, options: DatabasePoolOptions = {}) {
	const { schema: _schema, ...config } = options;
	let pool: Pool;
	let backup: (() => Promise<Blob>) | undefined;
	if (/^postgres(?:ql)?:\/\//i.test(url)) {
		const native = new pg.Pool({
			max: 10,
			connectionTimeoutMillis: 10000,
			idle_in_transaction_session_timeout: 30000,
			...config,
			types: {
				getTypeParser(oid, format) {
					if (oid === 20)
						return (value: string) => {
							const number = Number(value);
							return Number.isSafeInteger(number) ? number : value;
						};
					return pg.types.getTypeParser(oid, format);
				},
			},
			connectionString: url,
		});
		native.on("error", () => console.error("Database pool connection failed"));
		let ending: Promise<void> | undefined;
		const wrap = (
			executor: Pick<pg.PoolClient, "query">,
			releaseConnection: PoolClient["release"],
		): PoolClient => {
			let released = false,
				active = false;
			const assert = () => {
				if (released) throw new Error("Database client has been released");
			};
			const track = (sql: string) => {
				if (/^\s*BEGIN/i.test(sql)) active = true;
				if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) active = false;
			};
			return {
				async query<T>(sql: string, params?: unknown[]) {
					assert();
					const q = postgresStatement(sql, params);
					const r = await executor.query(q.sql, q.params);
					track(sql);
					return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
				},
				async raw(sql, params) {
					assert();
					const q = postgresStatement(sql, params);
					const r = await executor.query({
						text: q.sql,
						values: q.params,
						rowMode: "array",
					});
					track(sql);
					const columns = r.fields.map((f) => ({ name: f.name, origin: null }));
					return {
						values: r.rows,
						rows: r.rows.map((row) =>
							Object.fromEntries(columns.map((c, i) => [c.name, row[i]])),
						),
						columns,
						changes: r.rowCount ?? 0,
					};
				},
				release(error) {
					if (released) return;
					released = true;
					if (active)
						void executor.query("ROLLBACK").then(
							() => releaseConnection(error),
							() => releaseConnection(true),
						);
					else releaseConnection(error);
				},
			};
		};
		const root = wrap(native as unknown as pg.PoolClient, () => {});
		pool = {
			...root,
			async connect() {
				const client = await native.connect();
				return wrap(client, (e) => client.release(e));
			},
			end: () => (ending ??= native.end()),
		};
	} else {
		const directory = url.replace(/^pglite:/, "").replace(/^file:/, "");
		const { database: native, release: releaseOwnership } =
			ownedPGlite(directory);
		backup = async () => {
			await native.waitReady;
			return native.dumpDataDir();
		};
		let ended = false;
		let tail = Promise.resolve();
		async function acquire() {
			let release!: () => void;
			const previous = tail;
			tail = new Promise<void>((r) => {
				release = r;
			});
			await previous;
			return release;
		}
		const client = (unlock: () => void): PoolClient => {
			let released = false,
				active = false;
			const assert = () => {
				if (released) throw new Error("Database client has been released");
			};
			const track = (sql: string) => {
				if (/^\s*BEGIN/i.test(sql)) active = true;
				if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) active = false;
			};
			return {
				async query<T>(sql: string, params?: unknown[]) {
					assert();
					await native.waitReady;
					const q = postgresStatement(sql, params);
					const r = await native.query<T>(q.sql, q.params);
					track(sql);
					return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
				},
				async raw(sql, params) {
					assert();
					await native.waitReady;
					const q = postgresStatement(sql, params);
					const r = await native.query<unknown[]>(q.sql, q.params, {
						rowMode: "array",
					});
					track(sql);
					const columns = r.fields.map((f) => ({ name: f.name, origin: null }));
					return {
						rows: r.rows.map((row) =>
							Object.fromEntries(columns.map((c, i) => [c.name, row[i]])),
						),
						values: r.rows,
						columns,
						changes: r.affectedRows ?? 0,
					};
				},
				release() {
					if (released) return;
					released = true;
					if (active) void native.query("ROLLBACK").finally(unlock);
					else unlock();
				},
			};
		};
		pool = {
			async query<T>(sql: string, params?: unknown[]) {
				const release = await acquire();
				try {
					return await client(() => {}).query<T>(sql, params);
				} finally {
					release();
				}
			},
			async raw(sql, params) {
				const release = await acquire();
				try {
					return await client(() => {}).raw(sql, params);
				} finally {
					release();
				}
			},
			async connect() {
				return client(await acquire());
			},
			async end() {
				if (ended) return;
				ended = true;
				const release = await acquire();
				try {
					await native.close();
				} finally {
					releaseOwnership();
					release();
				}
			},
		};
	}
	// Queries through the owning pool inside a transaction run on its connection, so auth
	// hooks see the same uncommitted identity and local storage cannot deadlock. A second
	// connection from inside that transaction fails loudly; other requests keep the root pool.
	const identity = {};
	const rootQuery = pool.query.bind(pool),
		rootRaw = pool.raw.bind(pool),
		rootConnect = pool.connect.bind(pool);
	const held = () => heldConnection<PoolClient>(identity);
	Object.assign(pool, {
		[databaseIdentity]: identity,
		query<T>(sql: string, params?: unknown[]) {
			const current = held();
			return current
				? current.query<T>(sql, params)
				: rootQuery<T>(sql, params);
		},
		raw(sql: string, params?: unknown[]) {
			const current = held();
			return current ? current.raw(sql, params) : rootRaw(sql, params);
		},
		async connect() {
			if (held())
				throw new Error(
					"A transaction is already open on this database; use its executor instead of another connection",
				);
			return rootConnect();
		},
	});
	const dbFor = (executor: Pick<Pool, "raw" | "query">) => {
		const db = drizzle(
			async (sql, params) => {
				const r = await executor.raw(sql, params);
				return {
					rows: r.values.map((row) =>
						row.map((v) => (v instanceof Date ? v.toISOString() : v)),
					),
				};
			},
			{ schema: _schema ?? baseSchema },
		);
		return Object.assign(db, {
			execute<T = import("./sql").SqlRow>(query: SQL) {
				const q = dialect.sqlToQuery(query);
				return executor.query<T>(q.sql, q.params);
			},
		});
	};
	const db = Object.assign(dbFor(pool), {
		transaction<T>(work: (tx: ReturnType<typeof dbFor>) => Promise<T>) {
			// Auth library transactions (sign-up, account linking) keep read committed: their
			// writers are outside the application's fences and serialization retries.
			return transaction(pool, (client) => work(dbFor(client)), {
				isolation: "read committed",
			});
		},
	});
	const storage = { close: () => pool.end(), backup };
	const completePool = pool;
	databasePools.set(db, completePool);
	return { pool: completePool, db, storage };
}
export async function migrateDatabase(
	db: unknown,
	config: { migrationsFolder: string },
) {
	const { migrateDatabaseWithLock } = await import("./migrate");
	const pool = databasePools.get(db as object);
	if (!pool) throw new Error("Migration requires an owned database");
	return migrateDatabaseWithLock(pool, config);
}
const databasePools = new WeakMap<object, Pool>();
export function serverPoolOptions(
	env: Record<string, string | undefined>,
	name: string,
): DatabasePoolOptions {
	const value = (key: string, fallback: number) => {
		const v = Number(env[key] ?? fallback);
		if (!Number.isInteger(v) || v < 1)
			throw new Error(`${key} must be a positive integer`);
		return v;
	};
	return {
		max: value("DATABASE_POOL_MAX", 10),
		statement_timeout: value("DATABASE_STATEMENT_TIMEOUT_MS", 30000),
		application_name: name,
	};
}
export * from "./maintenance";
