import { createHash, randomBytes } from "node:crypto";

/**
 * The one-time setup link a fresh local instance prints on `start`. The `setup_link` table
 * holds at most one row, the digest of the current token: issuing replaces it (so an older
 * link stops working), creating the first account through it deletes it, and it is dead once
 * it expires or any account exists. Only the local commands issue it; only the setup sign-up
 * consumes it.
 */
export const SETUP_LINK_MINUTES = 15;

/** The query surface shared by a `pg` pool and the embedded database pool. */
type Queryable = {
	query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
};

const digest = (token: string) =>
	createHash("sha256").update(token).digest("hex");
const usable = `"tokenHash"=$1 and "expiresAt">clock_timestamp() and not exists(select 1 from "user")`;

/** A new setup token while the instance has no accounts, replacing any earlier one. */
export async function issueSetupLink(
	pool: Queryable,
): Promise<string | undefined> {
	const token = randomBytes(32).toString("base64url");
	const issued = await pool.query(
		`insert into setup_link(id,"tokenHash","expiresAt") select 'instance',$1,clock_timestamp() + interval '${SETUP_LINK_MINUTES} minutes' where not exists(select 1 from "user") on conflict(id) do update set "tokenHash"=excluded."tokenHash","expiresAt"=excluded."expiresAt"`,
		[digest(token)],
	);
	if (issued.rowCount === 1) return token;
	await pool.query("delete from setup_link");
	return undefined;
}

/** Whether the token would create the first account now; it is not used up. */
export async function setupLinkUsable(pool: Queryable, token: string) {
	if (!token) return false;
	const found = await pool.query(`select 1 from setup_link where ${usable}`, [
		digest(token),
	]);
	return found.rowCount === 1;
}

/** Use the token up; exactly one caller succeeds, and only while there are no accounts. */
export async function consumeSetupLink(pool: Queryable, token: string) {
	if (!token) return false;
	const consumed = await pool.query(
		`delete from setup_link where ${usable} returning id`,
		[digest(token)],
	);
	return consumed.rowCount === 1;
}
