import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient, SqlRow } from "./sql";

/** Statements on a transaction's one checked-out connection. */
export type Transaction = Pick<PoolClient, "query" | "raw">;
/**
 * Serializable is the default: PostgreSQL detects read/write dependencies between serializable
 * transactions, so a site need not lock everything it reads, and a conflict is retried. Read
 * committed is for the few high-rate paths whose invariants are single atomic statements and
 * explicit locks (gateway admission, work queues); a site choosing it must say why.
 */
export type Isolation = "read committed" | "repeatable read" | "serializable";
/**
 * An advisory lock named by `key`. A transaction's fences are taken in ascending `rank`, then
 * key, and before its snapshot, so the transaction sees everything committed by the previous
 * holder. PostgreSQL queues advisory lock requests fairly: a waiting exclusive request stops new
 * shared ones, so a stream of shared holders cannot starve it.
 */
export interface Fence {
	rank: number;
	key: string;
	shared?: boolean;
}
/** Reads made while acquiring fences, on the transaction's connection, outside the transaction. */
export interface FenceScope {
	query(text: string, values?: unknown[]): Promise<{ rows: SqlRow[] }>;
	/** Takes a fence; ranks and keys must not decrease (or the call throws). */
	hold(fence: Fence): Promise<void>;
}
export interface TransactionOptions {
	isolation?: Isolation;
	/** Re-run `work` after a serialization failure or deadlock, at most this many times.
	 * Defaults to 8 for serializable transactions and 0 otherwise. */
	retries?: number;
	/** Fences to hold for the whole transaction; a function may read (for example, to find a
	 * user's workspaces) between the fences it takes. */
	fences?: readonly Fence[] | ((scope: FenceScope) => Promise<void>);
}
/** The transaction kept losing serialization or deadlock conflicts. */
export class ConcurrentChange extends Error {
	constructor(options?: ErrorOptions) {
		super(
			"The records changed while preparing this action. Retry the action.",
			options,
		);
	}
}
/** Thrown by `work` when a fence set read before the transaction no longer covers what it
 * touches (a scope was added meanwhile); the transaction retries like a serialization failure. */
export class FenceChanged extends Error {
	constructor() {
		super("The locked scope changed; retrying");
	}
}
/** Structural connection: the package's pool clients and narrower test doubles both fit. */
export interface TransactionConnection {
	query(text: string, values?: unknown[]): Promise<unknown>;
	release(error?: Error | boolean): void;
}
/**
 * Pools opened by this package carry an identity object. Wrappers built by spreading a pool keep
 * it, so a nested transaction is detected however the database handle was wrapped.
 */
export const databaseIdentity: unique symbol = Symbol("toolstile.database");
type Host<C> = { connect(): Promise<C>; [databaseIdentity]?: object };
/** Every transaction this async context holds, by database: a nested transaction on another
 * database adds an entry and never hides the outer one. The map is never mutated in place. */
const open = new AsyncLocalStorage<ReadonlyMap<object, unknown>>();

/** The connection of the transaction this async context holds on that database, if any. */
export function heldConnection<C>(owner: object): C | undefined {
	return open.getStore()?.get(owner) as C | undefined;
}
const begin: Record<Isolation, string> = {
	"read committed": "BEGIN",
	"repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ",
	serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
};
/** A serialization failure, deadlock or changed fence set, also when a query builder wrapped
 * the driver's error (its `cause`). */
function conflict(error: unknown): boolean {
	for (let current = error, depth = 0; current && depth < 5; depth++) {
		if (current instanceof FenceChanged) return true;
		if (typeof current !== "object") return false;
		if (
			"code" in current &&
			(current.code === "40001" || current.code === "40P01")
		)
			return true;
		current = "cause" in current ? current.cause : undefined;
	}
	return false;
}
const order = (a: Fence, b: Fence) =>
	a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Runs `work` in one transaction on one checked-out connection, after taking its fences.
 * Queries through the owning pool inside `work` join this transaction; opening another
 * transaction or connection on the same database from inside it fails instead of waiting on a
 * second connection (PGlite has only one). A failed rollback or fence release destroys the
 * connection; the original error is always the one rethrown. Retried work must be safe to run
 * again: keep provider and network effects outside.
 */
export async function transaction<C extends TransactionConnection, T>(
	pool: Host<C>,
	work: (tx: Omit<C, "release">) => Promise<T>,
	options: TransactionOptions = {},
): Promise<T> {
	const { isolation = "serializable" } = options;
	const retries = options.retries ?? (isolation === "serializable" ? 8 : 0);
	if (!Number.isSafeInteger(retries) || retries < 0 || retries > 16)
		throw new Error("Invalid transaction retry bound");
	const owner = pool[databaseIdentity] ?? pool;
	if (heldConnection(owner))
		throw new Error(
			"A transaction is already open on this database; pass its executor instead of opening another",
		);
	for (let attempt = 0; ; attempt++) {
		const client = await pool.connect();
		let broken: Error | undefined;
		let fenced: string[] = [];
		try {
			fenced = await takeFences(client, options.fences, (cleanupError) => {
				broken = asError(cleanupError, "Fence release failed");
			});
			await client.query(begin[isolation]);
			try {
				if (fenced.length) await assertSessionAffine(client, fenced);
				const held = new Map(open.getStore() ?? []).set(owner, client);
				const value = await open.run(held, () => work(client));
				await client.query("COMMIT");
				return value;
			} catch (error) {
				await client.query("ROLLBACK").catch((rollbackError: unknown) => {
					broken = asError(rollbackError, "Transaction rollback failed");
				});
				throw error;
			}
		} catch (error) {
			if (!conflict(error)) throw error;
			if (attempt >= retries) throw new ConcurrentChange({ cause: error });
		} finally {
			if (fenced.length && !broken)
				await client
					.query("SELECT pg_advisory_unlock_all()")
					.catch((unlockError: unknown) => {
						broken = asError(unlockError, "Fence release failed");
					});
			client.release(broken);
		}
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(50, 2 ** attempt) + Math.random() * 10),
		);
	}
}
const asError = (value: unknown, message: string) =>
	value instanceof Error ? value : new Error(message);
/** Session-level fences before BEGIN, so the snapshot follows them; returns whether any held. */
async function takeFences(
	client: TransactionConnection,
	fences: TransactionOptions["fences"],
	/** A failed release after a partial acquisition: the connection must be destroyed. */
	onCleanupFailure: (error: unknown) => void,
) {
	const held: string[] = [];
	if (!fences) return held;
	let last: Fence | undefined;
	const scope: FenceScope = {
		query: async (text, values) =>
			(await client.query(text, values)) as { rows: SqlRow[] },
		async hold(fence) {
			if (last && order(last, fence) > 0)
				throw new Error(
					`Fence ${fence.key} taken out of order after ${last.key}`,
				);
			if (last && order(last, fence) === 0) {
				if (last.shared && !fence.shared)
					throw new Error(`Fence ${fence.key} cannot be upgraded`);
				return;
			}
			held.push(fence.key);
			await client.query(
				fence.shared
					? "SELECT pg_advisory_lock_shared(hashtextextended($1, 0))"
					: "SELECT pg_advisory_lock(hashtextextended($1, 0))",
				[fence.key],
			);
			last = fence;
		},
	};
	try {
		if (typeof fences === "function") await fences(scope);
		else {
			// The strongest mode per key, in order.
			const merged = new Map<string, Fence>();
			for (const fence of fences) {
				const seen = merged.get(fence.key);
				merged.set(fence.key, seen && !seen.shared ? seen : fence);
			}
			for (const fence of [...merged.values()].sort(order))
				await scope.hold(fence);
		}
	} catch (error) {
		if (held.length)
			await client
				.query("SELECT pg_advisory_unlock_all()")
				.catch(onCleanupFailure);
		throw error;
	}
	return held;
}
/**
 * Fences are session-level locks taken before BEGIN, so the backend running the transaction must
 * be the one that took them: a direct connection or a session-mode pooler. Through a
 * transaction-mode pooler they could be taken on another backend and two transactions could both
 * believe they hold one exclusively. Checked inside every fenced transaction, where any pooler
 * pins the backend, against the exact lock keys.
 */
async function assertSessionAffine(
	client: TransactionConnection,
	keys: string[],
) {
	const result = (await client.query(
		`select count(*)::integer as held from jsonb_array_elements_text($1::jsonb) k(key)
		where exists (select 1 from pg_locks l where l.locktype='advisory' and l.pid=pg_backend_pid()
			and l.granted and l.objsubid=1
			and l.classid=((hashtextextended(k.key,0) >> 32) & 4294967295)::oid
			and l.objid=(hashtextextended(k.key,0) & 4294967295)::oid)`,
		[JSON.stringify(keys)],
	)) as { rows?: { held: number }[] };
	if (result.rows?.[0]?.held !== keys.length)
		throw new Error(
			"Fences need a session-affine database connection: connect directly to PostgreSQL or through a session-mode pooler, not a transaction-mode pooler",
		);
}
/**
 * A shared fence inside a read committed transaction (released at its end), for high-rate paths
 * that read state whose writers hold the fence exclusively. Waits at most `timeoutMs`; a
 * timeout raises PostgreSQL's lock_not_available (55P03).
 */
export async function holdSharedFence(
	tx: { query(text: string, values?: unknown[]): Promise<unknown> },
	fence: Fence,
	timeoutMs: number,
) {
	await tx.query(
		"SELECT set_config('lock_timeout', $2, true), pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
		[fence.key, `${timeoutMs}ms`],
	);
	await tx.query("SELECT set_config('lock_timeout', '0', true)");
}
/**
 * Serializes a key that has no row to lock inside a transaction (taken after its snapshot, so a
 * serializable transaction still relies on conflict detection for what it read before).
 */
export async function advisoryLock(
	tx: { query(text: string, values?: unknown[]): Promise<unknown> },
	key: string,
) {
	await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
		key,
	]);
}
