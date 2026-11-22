import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "@toolstile/database/sql";
import { transaction } from "@toolstile/database/transaction";
import { accountFence, operatorsFence } from "./fences";

/**
 * The one-time setup link a fresh local instance prints on `start`. The `setup_link` table
 * holds at most one row, the digest of the current token: issuing replaces it (so an older
 * link stops working), creating the first account through it deletes it, and it is dead once
 * it expires or any account exists. Only the local commands issue it; only the setup sign-up
 * uses it.
 */
export const SETUP_LINK_MINUTES = 15;

/**
 * Whether an instance creates its first account through a setup link: only when the server
 * listens on loopback and its origin is plain HTTP on loopback, so the link can only be opened
 * on this machine. Other instances invite their first account with `bootstrap`.
 */
export function offersSetupLink(origin: string, listen: string) {
	const url = URL.parse(origin);
	return (
		["127.0.0.1", "::1"].includes(listen) &&
		url?.protocol === "http:" &&
		["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
	);
}

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

/**
 * Use the token up and create the first account with its password credential and operator
 * access, all in one transaction: either everything commits or nothing does. Returns the new
 * user's ID, or undefined when the link is used, expired or another account exists. A
 * concurrent registration of the same email makes the insert fail and rolls the link back.
 */
export async function createSetupAccount(
	pool: Pool,
	token: string,
	account: { email: string; name: string; passwordHash: string },
): Promise<string | undefined> {
	if (!token) return undefined;
	const userId = randomUUID();
	return transaction(
		pool,
		async (tx) => {
			const used = await tx.query(
				`delete from setup_link where ${usable} returning id`,
				[digest(token)],
			);
			if (used.rowCount !== 1) return undefined;
			await tx.query('insert into "user"(id,name,email) values($1,$2,$3)', [
				userId,
				account.name,
				account.email,
			]);
			await tx.query(
				`insert into account(id,"accountId","providerId","userId",password) values($1,$2,'credential',$2,$3)`,
				[randomUUID(), userId, account.passwordHash],
			);
			await tx.query(
				'insert into profiles("userId",operator) values($1,true)',
				[userId],
			);
			return userId;
		},
		// Granting operator access is an operator change (fences.ts).
		{ fences: [operatorsFence, accountFence(userId)] },
	);
}
