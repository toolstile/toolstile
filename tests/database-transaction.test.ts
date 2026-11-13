import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { liveSession } from "../packages/auth/src/session-check";
import { openDatabase } from "../packages/database/src/index";
import {
	advisoryLock,
	ConcurrentChange,
	FenceChanged,
	transaction,
} from "../packages/database/src/transaction";

function fakePool(
	options: { failRollback?: boolean; fail?: string[]; pooled?: boolean } = {},
) {
	const queries: string[] = [];
	const released: (Error | boolean | undefined)[] = [];
	const failures = [...(options.fail ?? [])];
	return {
		queries,
		released,
		async connect() {
			return {
				async query(text: string, values?: unknown[]) {
					queries.push(text);
					// The session-affinity check: every fence held, unless behind a
					// transaction-mode pooler that ran it on another backend.
					if (text.includes("pg_locks"))
						return {
							rows: [
								{
									held: options.pooled
										? 0
										: JSON.parse(String(values?.[0])).length,
								},
							],
						};
					if (options.failRollback && text === "ROLLBACK")
						throw new Error("connection lost");
					if (text === "COMMIT" && failures.length)
						throw Object.assign(new Error("conflict"), {
							code: failures.shift(),
						});
					return {};
				},
				release(error?: Error | boolean) {
					released.push(error);
				},
			};
		},
	};
}

describe("transaction", () => {
	it("commits and returns the connection to the pool", async () => {
		const pool = fakePool();
		await expect(transaction(pool, async () => "done")).resolves.toBe("done");
		// Serializable is the default.
		expect(pool.queries).toEqual([
			"BEGIN ISOLATION LEVEL SERIALIZABLE",
			"COMMIT",
		]);
		expect(pool.released).toEqual([undefined]);
	});
	it("rolls back and rethrows the work's error", async () => {
		const pool = fakePool();
		await expect(
			transaction(
				pool,
				async () => {
					throw new Error("work failed");
				},
				{ isolation: "read committed" },
			),
		).rejects.toThrow("work failed");
		expect(pool.queries).toEqual(["BEGIN", "ROLLBACK"]);
		expect(pool.released).toEqual([undefined]);
	});
	it("destroys a connection whose rollback fails and keeps the original error", async () => {
		const pool = fakePool({ failRollback: true });
		await expect(
			transaction(pool, async () => {
				throw new Error("work failed");
			}),
		).rejects.toThrow("work failed");
		expect(pool.released).toHaveLength(1);
		expect(pool.released[0]).toBeInstanceOf(Error);
		expect((pool.released[0] as Error).message).toBe("connection lost");
	});
	it("uses the requested isolation level", async () => {
		const pool = fakePool();
		await transaction(pool, async () => undefined, {
			isolation: "serializable",
		});
		expect(pool.queries[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
	});
	it("retries only serialization failures and deadlocks, within its bound", async () => {
		const pool = fakePool({ fail: ["40001", "40P01"] });
		let runs = 0;
		await transaction(pool, async () => runs++, { retries: 2 });
		expect(runs).toBe(3);
		const exhausted = fakePool({ fail: ["40001", "40001"] });
		await expect(
			transaction(exhausted, async () => undefined, { retries: 1 }),
		).rejects.toBeInstanceOf(ConcurrentChange);
		const other = fakePool({ fail: ["23505"] });
		await expect(
			transaction(other, async () => undefined, { retries: 4 }),
		).rejects.toMatchObject({ code: "23505" });
		expect(other.queries.filter((q) => q.startsWith("BEGIN"))).toHaveLength(1);
		// Serializable transactions retry by default; read committed ones do not.
		const serializable = fakePool({ fail: ["40001"] });
		await transaction(serializable, async () => undefined);
		expect(
			serializable.queries.filter((q) => q.startsWith("BEGIN")),
		).toHaveLength(2);
		await expect(
			transaction(fakePool({ fail: ["40001"] }), async () => undefined, {
				isolation: "read committed",
			}),
		).rejects.toBeInstanceOf(ConcurrentChange);
		await expect(
			transaction(pool, async () => undefined, { retries: 17 }),
		).rejects.toThrow("Invalid transaction retry bound");
	});
});

describe("fences", () => {
	it("are taken in order before BEGIN and released after the transaction", async () => {
		const pool = fakePool();
		await transaction(pool, async () => undefined, {
			fences: [
				{ rank: 2, key: "workspace:b" },
				{ rank: 1, key: "user:a", shared: true },
				{ rank: 2, key: "workspace:a" },
				{ rank: 2, key: "workspace:a", shared: true },
			],
		});
		expect(pool.queries).toEqual([
			"SELECT pg_advisory_lock_shared(hashtextextended($1, 0))",
			"SELECT pg_advisory_lock(hashtextextended($1, 0))",
			"SELECT pg_advisory_lock(hashtextextended($1, 0))",
			"BEGIN ISOLATION LEVEL SERIALIZABLE",
			expect.stringContaining("pg_locks"),
			"COMMIT",
			"SELECT pg_advisory_unlock_all()",
		]);
	});
	it("fails loudly when fences are not held by the transaction's backend", async () => {
		const pool = fakePool({ pooled: true });
		await expect(
			transaction(pool, async () => "ran", {
				fences: [{ rank: 1, key: "user:a" }],
			}),
		).rejects.toThrow("session-affine");
		expect(pool.queries).toContain("ROLLBACK");
	});
	it("refuses a fence taken out of order and retries a changed fence set", async () => {
		const pool = fakePool();
		await expect(
			transaction(pool, async () => undefined, {
				fences: async (scope) => {
					await scope.hold({ rank: 2, key: "workspace:a" });
					await scope.hold({ rank: 1, key: "user:a" });
				},
			}),
		).rejects.toThrow("out of order");
		expect(pool.queries.at(-1)).toBe("SELECT pg_advisory_unlock_all()");
		let runs = 0;
		await transaction(
			fakePool(),
			async () => {
				if (++runs === 1) throw new FenceChanged();
			},
			{ fences: [{ rank: 1, key: "user:a" }] },
		);
		expect(runs).toBe(2);
	});
	it("destroys the connection when a partial acquisition cannot be released", async () => {
		const queries: string[] = [];
		const released: (Error | boolean | undefined)[] = [];
		const pool = {
			async connect() {
				return {
					async query(text: string, values?: unknown[]) {
						queries.push(text);
						if (
							text.startsWith("SELECT pg_advisory_lock(") &&
							values?.[0] === "workspace:b"
						)
							throw new Error("second fence failed");
						if (text === "SELECT pg_advisory_unlock_all()")
							throw new Error("release failed");
						return {};
					},
					release(error?: Error | boolean) {
						released.push(error);
					},
				};
			},
		};
		await expect(
			transaction(pool, async () => undefined, {
				fences: [
					{ rank: 2, key: "workspace:a" },
					{ rank: 2, key: "workspace:b" },
				],
			}),
		).rejects.toThrow("second fence failed");
		expect(queries).not.toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
		expect(released).toHaveLength(1);
		expect(released[0]).toBeInstanceOf(Error);
		expect((released[0] as Error).message).toBe("release failed");
	});
	it("work on PGlite, where isolation is moot but the path is the same", async () => {
		const { pool } = openDatabase(":memory:");
		try {
			await pool.query("create table items(id text primary key)");
			await transaction(
				pool,
				async (tx) => {
					await tx.query("insert into items values('fenced')");
				},
				{ fences: [{ rank: 1, key: "user:a" }] },
			);
			expect((await pool.query("select id from items")).rows).toEqual([
				{ id: "fenced" },
			]);
			// The fence is released: it can be taken again at once.
			await transaction(pool, async () => undefined, {
				fences: [{ rank: 1, key: "user:a" }],
			});
		} finally {
			await pool.end();
		}
	});
});

describe("transactions on an opened database (PGlite)", () => {
	it("joins pool queries and refuses a nested transaction or connection", async () => {
		const { db, pool } = openDatabase(":memory:");
		try {
			await pool.query("create table items(id text primary key)");
			await expect(
				transaction(pool, async (tx) => {
					await tx.query("insert into items values('inside')");
					// A pool query in the same async context runs on the held connection.
					expect((await pool.query("select id from items")).rows).toEqual([
						{ id: "inside" },
					]);
					await expect(
						transaction(pool, async () => undefined),
					).rejects.toThrow("already open on this database");
					await expect(db.transaction(async () => undefined)).rejects.toThrow(
						"already open on this database",
					);
					await expect(pool.connect()).rejects.toThrow(
						"already open on this database",
					);
					throw new Error("rollback");
				}),
			).rejects.toThrow("rollback");
			expect((await pool.query("select id from items")).rows).toEqual([]);
			// A wrapper made by spreading the pool is the same database.
			const wrapped = { ...pool };
			await expect(
				transaction(wrapped, () => transaction(pool, async () => undefined)),
			).rejects.toThrow("already open on this database");
		} finally {
			await pool.end();
		}
	});
});

describe("nested transactions on two databases", () => {
	it("keeps the outer database's transaction while one on another database is open", async () => {
		const a = openDatabase(":memory:"),
			b = openDatabase(":memory:");
		try {
			await a.pool.query("create table items(id text primary key)");
			await b.pool.query("create table items(id text primary key)");
			await expect(
				transaction(a.pool, async () => {
					await transaction(b.pool, async () => {
						// Database A's pool still runs on A's held connection here.
						await a.pool.query("insert into items values('a')");
						await b.pool.query("insert into items values('b')");
						await expect(
							transaction(a.pool, async () => undefined),
						).rejects.toThrow("already open on this database");
					});
					throw new Error("roll back A");
				}),
			).rejects.toThrow("roll back A");
			expect((await a.pool.query("select id from items")).rows).toEqual([]);
			expect((await b.pool.query("select id from items")).rows).toEqual([
				{ id: "b" },
			]);
		} finally {
			await a.pool.end();
			await b.pool.end();
		}
	}, 30_000);
});

const server = process.env.TEST_DATABASE_URL?.startsWith("postgres")
	? process.env.TEST_DATABASE_URL
	: undefined;
describe.skipIf(!server)("transactions on PostgreSQL", () => {
	async function database() {
		const name = `transaction_${randomUUID().replaceAll("-", "")}`;
		const admin = new pg.Pool({ connectionString: server });
		await admin.query(`CREATE DATABASE "${name}"`);
		const url = new URL(server ?? "");
		url.pathname = `/${name}`;
		const opened = openDatabase(url.href, { max: 20 });
		return {
			...opened,
			url: url.href,
			async close() {
				await opened.pool.end();
				await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
				await admin.end();
			},
		};
	}
	it("a conditional update admits exactly the allowance under concurrency", async () => {
		const { pool, close } = await database();
		try {
			await pool.query(
				"create table quota(id text primary key, used integer not null, allowance integer not null)",
			);
			await pool.query("insert into quota values('q',0,25)");
			const results = await Promise.all(
				Array.from({ length: 100 }, () =>
					transaction(pool, async (tx) => {
						const { rowCount } = await tx.query(
							"update quota set used=used+1 where id='q' and used<allowance returning used",
						);
						return rowCount === 1;
					}),
				),
			);
			expect(results.filter(Boolean)).toHaveLength(25);
			expect((await pool.query("select used from quota")).rows[0].used).toBe(
				25,
			);
		} finally {
			await close();
		}
	});
	it("an advisory lock serializes check-then-insert without a row to lock", async () => {
		const { pool, close } = await database();
		try {
			await pool.query("create table claims(id text primary key, key text)");
			const claimed = await Promise.all(
				Array.from({ length: 20 }, () =>
					transaction(pool, async (tx) => {
						await advisoryLock(tx, "claim:k");
						const { rowCount } = await tx.query(
							"select 1 from claims where key='k'",
						);
						if (rowCount) return false;
						await tx.query("insert into claims values($1,'k')", [randomUUID()]);
						return true;
					}),
				),
			);
			expect(claimed.filter(Boolean)).toHaveLength(1);
		} finally {
			await close();
		}
	});
	it("takes a fence before the snapshot, so a serializable reader sees the previous holder's commit", async () => {
		const { pool, close } = await database();
		try {
			await pool.query("create table state(id integer primary key, v integer)");
			await pool.query("insert into state values(1,0)");
			const fence = { rank: 2, key: "workspace:w" };
			const holder = await pool.connect();
			await holder.query("BEGIN");
			await holder.query(
				"select pg_advisory_xact_lock(hashtextextended($1, 0))",
				[fence.key],
			);
			await holder.query("update state set v=1 where id=1");
			const seen = transaction(
				pool,
				async (tx) => {
					const {
						rows: [row],
					} = await tx.query<{ v: number }>("select v from state where id=1");
					return row.v;
				},
				{ fences: [fence] },
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			await holder.query("COMMIT");
			holder.release();
			expect(await seen).toBe(1);
		} finally {
			await close();
		}
	});
	it("refuses a session signed out after a serializable snapshot: the share lock fails, the retry refuses", async () => {
		const { pool, close, url } = await database();
		// Another connection, as the auth library's own statements are.
		const other = openDatabase(url).pool;
		try {
			await pool.query(
				'create table session(id text primary key, "userId" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz not null default now())',
			);
			await pool.query(
				"insert into session values('s','u',now()+interval '1 hour',now())",
			);
			const attempts: { plain: number; locked: string }[] = [];
			const outcome = await transaction(pool, async (tx) => {
				// The snapshot is taken here, before the sign-out commits.
				const plain = (await tx.query("select 1 from session where id='s'"))
					.rowCount;
				if (!attempts.length)
					// The auth library deletes the session in its own autocommit statement.
					await other.query("delete from session where id='s'");
				try {
					const live = await liveSession(tx, {
						userId: "u",
						sessionId: "s",
					});
					attempts.push({ plain, locked: String(live) });
					return live;
				} catch (error) {
					attempts.push({
						plain,
						locked: String((error as { code?: string }).code),
					});
					throw error;
				}
			});
			// A plain read in the first attempt still saw the old row; the share lock raised a
			// serialization failure instead, and the retry refused.
			expect(attempts).toEqual([
				{ plain: 1, locked: "40001" },
				{ plain: 0, locked: "false" },
			]);
			expect(outcome).toBe(false);
		} finally {
			await other.end();
			await close();
		}
	});
	it("retries serialization failures at the serializable level", async () => {
		const { pool, close } = await database();
		try {
			await pool.query("create table cells(id integer primary key, v integer)");
			await pool.query("insert into cells values(1,0),(2,0)");
			// Write skew: each transaction reads both rows and writes one.
			const runs = { count: 0 };
			await Promise.all(
				[1, 2].map((id) =>
					transaction(
						pool,
						async (tx) => {
							runs.count++;
							const {
								rows: [sum],
							} = await tx.query<{ total: number }>(
								"select sum(v)::integer as total from cells",
							);
							await new Promise((resolve) => setTimeout(resolve, 20));
							if (sum.total === 0)
								await tx.query("update cells set v=1 where id=$1", [id]);
						},
						{ isolation: "serializable", retries: 4 },
					),
				),
			);
			expect(
				(await pool.query("select sum(v)::integer as total from cells")).rows[0]
					.total,
			).toBe(1);
			expect(runs.count).toBeGreaterThan(2);
		} finally {
			await close();
		}
	});
});
