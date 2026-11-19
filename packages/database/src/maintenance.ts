import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Pool } from "./sql";
/** Expired sessions are already rejected; this only removes the sign-in IP address and
 * user agent of sessions nobody signed out of. It also removes CLI sign-in codes an hour past
 * expiry (redeemed ones are already gone) and device approvals whose code was never redeemed.
 * Bounded per scan; the next scan continues. Returns the number of sessions deleted. */
export async function purgeExpiredSessions(
	pool: Pick<Pool, "query">,
	{ batch = 1000, batches = 10 } = {},
) {
	const statements = [
		`delete from session where id in (select id from session where "expiresAt" < clock_timestamp() - (3600000) * interval '1 millisecond' order by "expiresAt" limit $1)`,
		`delete from device_code where id in (select id from device_code where "expiresAt" < clock_timestamp() - (3600000) * interval '1 millisecond' limit $1)`,
		`delete from cli_device_links where "deviceCode" in (select "deviceCode" from cli_device_links where "sessionId" is null and "createdAt" < clock_timestamp() - (3600000) * interval '1 millisecond' limit $1)`,
	];
	let deleted = 0;
	for (const [index, statement] of statements.entries())
		for (let round = 0; round < batches; round++) {
			const { rowCount } = await pool.query(statement, [batch]);
			if (index === 0) deleted += rowCount ?? 0;
			if ((rowCount ?? 0) < batch) break;
		}
	return deleted;
}
/**
 * Delete OAuth rows that can no longer be used, in bounded batches.
 * - Access tokens and flow selections an hour past expiry.
 * - Refresh tokens a day past expiry (rotated ones keep their original expiry, so reuse
 *   detection still sees them until then) that no remaining access token references.
 * - Dynamically registered clients (not CIMD, whose rows carry a clientDiscoveryId) created
 *   more than 30 days ago with no tokens or consents left.
 */
export async function purgeExpiredOAuth(
	pool: Pick<Pool, "query">,
	{ batch = 1000, batches = 10 } = {},
) {
	const statements = [
		`delete from "oauthAccessToken" where id in (select id from "oauthAccessToken" where "expiresAt" < clock_timestamp() - (3600000) * interval '1 millisecond' limit $1)`,
		`delete from "oauthRefreshToken" where id in (select r.id from "oauthRefreshToken" r where r."expiresAt" < clock_timestamp() - (86400000) * interval '1 millisecond' and (r."rotationReplayExpiresAt" is null or r."rotationReplayExpiresAt" < clock_timestamp()) and not exists (select 1 from "oauthAccessToken" a where a."refreshId" = r.id) limit $1)`,
		`delete from oauth_flow_selection where id in (select id from oauth_flow_selection where "expiresAt" < clock_timestamp() - (3600000) * interval '1 millisecond' limit $1)`,
		`delete from "oauthClient" where id in (select c.id from "oauthClient" c where c."clientDiscoveryId" is null and c."createdAt" < clock_timestamp() - (2592000000) * interval '1 millisecond' and not exists (select 1 from "oauthAccessToken" a where a."clientId" = c."clientId") and not exists (select 1 from "oauthRefreshToken" r where r."clientId" = c."clientId") and not exists (select 1 from "oauthConsent" o where o."clientId" = c."clientId") limit $1)`,
	];
	let deleted = 0;
	for (const statement of statements)
		for (let round = 0; round < batches; round++) {
			const { rowCount } = await pool.query(statement, [batch]);
			deleted += rowCount ?? 0;
			if ((rowCount ?? 0) < batch) break;
		}
	return deleted;
}
/** Delete one agent's OAuth grants without disabling a client shared by other agents.
 * Run inside the same transaction that deletes the application authorizations.
 */
export async function deleteAuthorizationOAuth(
	tx: { execute(query: SQL): Promise<unknown> },
	referenceIds: string[],
) {
	if (!referenceIds.length) return;
	await tx.execute(
		sql`delete from "oauthAccessToken" where "referenceId" in (select value from jsonb_array_elements_text(${JSON.stringify(referenceIds)})) or "refreshId" in (select id from "oauthRefreshToken" where "referenceId" in (select value from jsonb_array_elements_text(${JSON.stringify(referenceIds)})))`,
	);
	await tx.execute(
		sql`delete from "oauthRefreshToken" where "referenceId" in (select value from jsonb_array_elements_text(${JSON.stringify(referenceIds)}))`,
	);
	await tx.execute(
		sql`delete from "oauthConsent" where "referenceId" in (select value from jsonb_array_elements_text(${JSON.stringify(referenceIds)}))`,
	);
	await tx.execute(
		sql`delete from oauth_flow_selection where "referenceId" in (select value from jsonb_array_elements_text(${JSON.stringify(referenceIds)}))`,
	);
}
