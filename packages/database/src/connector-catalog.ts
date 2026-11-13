import type { Pool } from "@toolstile/database/sql";
import { type SQL, sql } from "drizzle-orm";
/** Idempotent connection requests (`connector_requests`). */
export class ConnectorRequestConflict extends Error {}
type Executor = {
	execute(query: SQL): Promise<unknown>;
};
type Identity = {
	ownerId: string;
	scopeId: string;
};
type Request = {
	requestId: string;
	fingerprint: string;
};
/** Reuse the application's transaction: no nested pool checkout while it holds a connection. */
export async function withConnectorRequest<T>(
	tx: Executor,
	identity: Identity,
	request: Request,
	work: () => Promise<T>,
	replayValid: (response: T) => Promise<boolean>,
): Promise<T> {
	const replay = await replayConnectorRequest(
		tx,
		identity,
		request,
		replayValid,
	);
	if (replay) return replay.response;
	const response = await work();
	await tx.execute(
		sql`INSERT INTO connector_requests(owner_id,scope_id,request_id,fingerprint,response) VALUES(${identity.ownerId},${identity.scopeId},${request.requestId},${request.fingerprint},${JSON.stringify(response)})`,
	);
	return response;
}
/**
 * Under this request's lock (held until `tx` ends): the stored response of a matching earlier
 * request that `replayValid` still authorizes, or undefined for a new request. Another
 * fingerprint, or a response that is no longer valid, conflicts. Callers look this up before
 * any network check, so a replay never contacts the server.
 */
export async function replayConnectorRequest<T>(
	tx: Executor,
	identity: Identity,
	request: Request,
	replayValid: (response: T) => Promise<boolean>,
): Promise<
	| {
			response: T;
	  }
	| undefined
> {
	// A new request has no row to lock yet: the key lock serializes duplicates until `tx` ends.
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`connector:${JSON.stringify([identity.ownerId, identity.scopeId, request.requestId])}`},0))`,
	);
	// Retention is cleanupConnectorRequests' job; here only this key's lapsed entry is dropped,
	// under its lock, so a request ID older than the window is never replayed.
	await tx.execute(
		sql`DELETE FROM connector_requests WHERE owner_id=${identity.ownerId} AND scope_id=${identity.scopeId} AND request_id=${request.requestId} AND created_at < clock_timestamp() - (86400000) * interval '1 millisecond'`,
	);
	const result = (await tx.execute(
		sql`SELECT fingerprint,response FROM connector_requests WHERE owner_id=${identity.ownerId} AND scope_id=${identity.scopeId} AND request_id=${request.requestId} AND created_at >= clock_timestamp() - (86400000) * interval '1 millisecond'`,
	)) as {
		rows: {
			fingerprint: string;
			response: T;
		}[];
	};
	const saved = result.rows[0];
	if (saved) {
		if (saved.fingerprint !== request.fingerprint)
			throw new ConnectorRequestConflict(
				"This connection request was already used with different settings. Start a new connection.",
			);
		if (!(await replayValid(saved.response)))
			throw new ConnectorRequestConflict(
				"This connection was removed. Start a new connection.",
			);
		return { response: saved.response };
	}
	return undefined;
}
/** Periodic cleanup also bounds retention while nobody is creating new connections. */
export async function cleanupConnectorRequests(pool: Pool) {
	await pool.query(
		"DELETE FROM connector_requests WHERE created_at < clock_timestamp() - (86400000) * interval '1 millisecond'",
	);
}
