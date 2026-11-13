/**
 * Whether a request's session row still exists (and, with `freshSeconds`, was created within that
 * many seconds). The row is share-locked, so a sign-out or revocation committed after a
 * serializable transaction's snapshot raises a serialization failure there (the transaction
 * retries and is refused), and one not yet committed is waited for. A committed sign-out is
 * therefore always seen. Use this for every session or freshness check inside a transaction.
 */
export async function liveSession(
	executor: {
		query(
			text: string,
			values?: unknown[],
		): Promise<{ rowCount: number | null }>;
	},
	session: { userId: string; sessionId?: string | null },
	options: { freshSeconds?: number } = {},
) {
	if (!session.sessionId) return false;
	const { rowCount } = await executor.query(
		`select 1 from session where id=$1 and "userId"=$2 and "expiresAt">clock_timestamp()
		and ($3::double precision is null or "createdAt">clock_timestamp() - $3::double precision * interval '1 second')
		for share`,
		[session.sessionId, session.userId, options.freshSeconds ?? null],
	);
	return !!rowCount;
}
