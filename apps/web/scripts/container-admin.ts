import { createHash, randomBytes } from "node:crypto";
// The migration entry avoids bundling the embedded database into this command.
import { migrateDatabaseWithLock } from "@toolstile/database/migrate";
import pg from "pg";

const [command, email] = process.argv.slice(2);
if (command === "validate") {
	// Reuse server validation without constructing authentication/runtime services.
	await import("../src/server/env");
} else {
	if (!/^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL ?? ""))
		throw new Error("Container commands require PostgreSQL");
	const pool = new pg.Pool({
		connectionString: process.env.DATABASE_URL,
		max: 1,
		connectionTimeoutMillis: 10000,
	});
	try {
		if (command === "migrate") {
			await migrateDatabaseWithLock(
				{
					async connect() {
						const client = await pool.connect();
						return {
							async query<T>(sql: string, params?: unknown[]) {
								const result = await client.query(sql, params);
								return {
									rows: result.rows as T[],
									rowCount: result.rowCount ?? result.rows.length,
								};
							},
							release: () => client.release(),
						};
					},
				},
				{ migrationsFolder: "/app/postgres-migrations" },
			);
			console.log("Migrations applied");
		} else if (command === "bootstrap") {
			if (!email?.includes("@"))
				throw new Error("bootstrap requires an email address");
			const origin = new URL(process.env.BETTER_AUTH_URL ?? "").origin;
			const token = `ts_${randomBytes(32).toString("base64url")}`;
			const digest = createHash("sha256").update(token).digest("hex");
			await pool.query(
				'insert into invitations(id,email,"expiresAt") values($1,$2,$3) on conflict(email) do update set id=excluded.id,"expiresAt"=excluded."expiresAt"',
				[digest, email.toLowerCase(), new Date(Date.now() + 86400000)],
			);
			console.log(
				`Invitation (valid 24 hours): ${origin}/api/auth/accept-invitation/${token}`,
			);
		} else if (command === "operator") {
			if (!email) throw new Error("operator requires an email address");
			const result = await pool.query(
				'insert into profiles("userId",operator) select id,true from "user" where email=$1 on conflict("userId") do update set operator=true returning "userId"',
				[email.toLowerCase()],
			);
			if (!result.rowCount) throw new Error("Create the invited account first");
			console.log("Operator access granted to the selected account");
		} else throw new Error("Unknown container command");
	} finally {
		await pool.end();
	}
}
