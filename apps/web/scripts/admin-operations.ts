import { createHash, randomBytes } from "node:crypto";

/** The query surface shared by a `pg` pool and the embedded database pool. */
type Queryable = {
	query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
};

/** Create or renew the invitation for an email and return its 24-hour link. */
export async function inviteUser(pool: Queryable, email: string, url: string) {
	if (!email?.includes("@"))
		throw new Error("bootstrap requires an email address");
	const origin = new URL(url).origin;
	const token = `ts_${randomBytes(32).toString("base64url")}`;
	const digest = createHash("sha256").update(token).digest("hex");
	await pool.query(
		'insert into invitations(id,email,"expiresAt") values($1,$2,$3) on conflict(email) do update set id=excluded.id,"expiresAt"=excluded."expiresAt"',
		[digest, email.toLowerCase(), new Date(Date.now() + 86400000)],
	);
	return `${origin}/api/auth/accept-invitation/${token}`;
}

/** Make an existing account an instance operator. */
export async function grantOperator(pool: Queryable, email: string) {
	if (!email) throw new Error("operator requires an email address");
	const result = await pool.query(
		'insert into profiles("userId",operator) select id,true from "user" where email=$1 on conflict("userId") do update set operator=true returning "userId"',
		[email.toLowerCase()],
	);
	if (!result.rowCount) throw new Error("Create the invited account first");
}
