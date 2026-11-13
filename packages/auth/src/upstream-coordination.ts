import { randomUUID } from "node:crypto";
import type { ConnectionStatus } from "@toolstile/database/connection-status";
import type { Pool } from "@toolstile/database/sql";
import { UpstreamReconnectRequired } from "@toolstile/gateway";

/** Grant identity, rather than a connection/workspace, owns rotating tokens. A durable
 * pending marker is committed before the external exchange. A crash or ambiguous
 * response requires reconnection; expiry never authorizes replaying that refresh. */
/**
 * Marks only connections still bound to this grant: one signed in again holds a new grant. The
 * binding row is locked first, the same order sign-in uses, so a sign-in that replaces the grant
 * concurrently is either seen (and its connection skipped) or overwrites this mark afterwards.
 */
export async function markGrantReconnect(pool: Pick<Pool, "query">, grantId: string) {
	await pool.query(
		`WITH bound AS (SELECT "connectionId" FROM connection_oauth WHERE "grantId"=$1 FOR UPDATE)
		 UPDATE connections SET status=$2 WHERE id IN (SELECT "connectionId" FROM bound)`,
		[grantId, "needs reconnection" satisfies ConnectionStatus]);
}

export function createGrantCoordinator(pool: Pick<Pool, "query">) {
	const markReconnect = (grantId: string) => markGrantReconnect(pool, grantId);
	return async function coordinate<T>(
		connectionId: string,
		work: (lease: {
			/** The grant this lease holds; a failure may change only connections that use it. */
			grantId: string;
			encryptedData: string;
			beginRefresh(): Promise<void>;
			persist(encryptedData: string): Promise<void>;
		}) => Promise<T>,
	): Promise<T> {
		const owner = randomUUID();
		const deadline = Date.now() + 20_000;
		let grantId: string | undefined;
		let encryptedData: string | undefined;
		while (Date.now() < deadline) {
			const { rows: [grant] } = await pool.query<{
				id: string; encryptedData: string; refreshPending: boolean;
				leaseId: string | null; leaseUntil: Date | null;
			}>(`SELECT g.* FROM upstream_oauth_grants g JOIN connection_oauth c ON c."grantId"=g.id WHERE c."connectionId"=$1`, [connectionId]);
			if (!grant) throw new UpstreamReconnectRequired();
			if (grant.refreshPending && (!grant.leaseId || Number(grant.leaseUntil) <= Date.now())) {
				// An earlier holder stopped mid-refresh; its outcome is unknown, so never replay it.
				await markReconnect(grant.id);
				throw new UpstreamReconnectRequired();
			}
			const { rowCount } = await pool.query(
				`UPDATE upstream_oauth_grants SET "leaseId"=$2,"leaseUntil"=$3
				 WHERE id=$1 AND "refreshPending"=false AND ("leaseId" IS NULL OR "leaseUntil"<=$4)`,
				[grant.id, owner, new Date(Date.now() + 120_000), new Date()],
			);
			if (rowCount) {
				// Read after acquisition: an earlier holder may have rotated between our
				// first read and its release. Its new token is the only valid snapshot.
				const { rows: [current] } = await pool.query<{ encryptedData: string }>(
					`SELECT g."encryptedData" FROM upstream_oauth_grants g JOIN connection_oauth c ON c."grantId"=g.id
					 WHERE g.id=$1 AND g."leaseId"=$2 AND c."connectionId"=$3`, [grant.id, owner, connectionId]);
				grantId = grant.id;
				encryptedData = current?.encryptedData;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (!grantId) throw new Error("MCP authentication is busy. Retry the request.");
		let pending = false;
		try {
			if (!encryptedData) throw new UpstreamReconnectRequired();
			return await work({
				grantId,
				encryptedData,
				async beginRefresh() {
					const result = await pool.query(
						`UPDATE upstream_oauth_grants SET "refreshPending"=true WHERE id=$1 AND "leaseId"=$2 AND "leaseUntil">$3`,
						[grantId, owner, new Date()],
					);
					if (!result.rowCount) throw new UpstreamReconnectRequired();
					pending = true;
				},
				async persist(value) {
					const result = await pool.query(
						`UPDATE upstream_oauth_grants SET "encryptedData"=$3,"updatedAt"=$4,"refreshPending"=false WHERE id=$1 AND "leaseId"=$2 AND "leaseUntil">$4`,
						[grantId, owner, value, new Date()],
					);
					if (!result.rowCount) throw new UpstreamReconnectRequired();
					pending = false;
				},
			});
		} catch (error) {
			if (pending) {
				await markReconnect(grantId);
				throw new UpstreamReconnectRequired();
			}
			throw error;
		} finally {
			await pool.query(`UPDATE upstream_oauth_grants SET "leaseId"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseId"=$2`, [grantId, owner]);
		}
	};
}
