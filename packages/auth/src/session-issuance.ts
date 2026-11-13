import type { Pool } from "@toolstile/database/sql";
import {
	databaseIdentity,
	type Fence,
	heldConnection,
	holdSharedFence,
	type Transaction,
	transaction,
} from "@toolstile/database/transaction";

/**
 * Orders session issuance with the host's account changes that revoke sessions (recovery,
 * resets, suspension, deletion), which hold the account's fence exclusively and record an audit
 * event in the same transaction.
 *
 * When a session-issuing request starts, its start time is read under the account's fence held
 * shared, so a revoking change either committed before (and the credential check that follows
 * sees it) or begins after that instant. After the session row is written, the fence is taken
 * shared again (waiting for a change in progress) and a revoking change recorded after the start
 * time deletes the new session and refuses the sign-in. A change starting later revokes the
 * session itself.
 */
export interface SessionIssuanceOptions {
	pool: Pool;
	/** The account fence the host's revoking changes hold exclusively. */
	fence(userId: string): Fence;
	/**
	 * Whether a session-revoking change to the account was recorded after `since`, a database
	 * timestamp in its text form: compare it in SQL (`$n::timestamptz`) to keep microseconds.
	 */
	revokedSince(
		executor: Pick<Transaction, "query">,
		userId: string,
		since: string,
	): Promise<boolean>;
	/** The account a request will sign in, when it is known before any credential check. */
	subject?(
		path: string,
		body: unknown,
		pool: Pool,
	): Promise<string | undefined>;
}
/** Paths that create sessions after validating a credential. */
const ISSUING =
	/^\/(sign-in\/|sign-up\/|callback\/|oauth2\/callback\/|one-tap\/|device\/token$)/;
const FENCE_WAIT_MS = 10_000;

export function sessionIssuanceGuard(options: SessionIssuanceOptions) {
	const started = new WeakMap<object, { since: string }>();
	const owner = (options.pool as { [databaseIdentity]?: object })[
		databaseIdentity
	];
	/** Runs on the auth library's open transaction if it has one, else in a short one. */
	async function fenced<T>(
		userId: string,
		work: (tx: Pick<Transaction, "query">) => Promise<T>,
	) {
		const held = owner ? heldConnection<Transaction>(owner) : undefined;
		if (held) {
			await holdSharedFence(
				held,
				{ ...options.fence(userId), shared: true },
				FENCE_WAIT_MS,
			);
			return work(held);
		}
		return transaction(options.pool, work, {
			isolation: "read committed",
			fences: [{ ...options.fence(userId), shared: true }],
		});
	}
	// Text keeps the database's microsecond precision; a JavaScript Date would truncate it.
	const now = (tx: Pick<Transaction, "query">) =>
		tx
			.query<{ now: string }>("select clock_timestamp()::text as now")
			.then(({ rows: [row] }) => row.now);
	async function subject(path: string, body: unknown) {
		if (path === "/sign-in/email") {
			const email = (body as { email?: unknown } | undefined)?.email;
			if (typeof email !== "string") return undefined;
			const {
				rows: [user],
			} = await options.pool.query<{ id: string }>(
				'select id from "user" where lower(email)=lower($1)',
				[email],
			);
			return user?.id;
		}
		return options.subject?.(path, body, options.pool);
	}
	return {
		/** Before a session-issuing endpoint: its start time, read under the account's fence. */
		async begin(context: object, path: string | undefined, body: unknown) {
			if (!path || !ISSUING.test(path)) return;
			const userId = await subject(path, body);
			const since = userId
				? await fenced(userId, now)
				: await now(options.pool);
			started.set(context, { since });
		},
		/** After a session row is written: refuse it if the account was revoked since the start. */
		async confirm(
			context: object | undefined,
			session: { id: string; userId: string },
		) {
			const start = context ? started.get(context) : undefined;
			if (!start) return true;
			return fenced(session.userId, async (tx) => {
				if (!(await options.revokedSince(tx, session.userId, start.since)))
					return true;
				await tx.query("delete from session where id=$1", [session.id]);
				return false;
			});
		},
	};
}
