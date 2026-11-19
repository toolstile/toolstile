// The migration entry avoids bundling the embedded database into this command.
import { migrateDatabaseWithLock } from "@toolstile/database/migrate";
import pg from "pg";
import { grantOperator, inviteUser } from "./admin-operations";

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
			const link = await inviteUser(
				pool,
				email,
				process.env.BETTER_AUTH_URL ?? "",
			);
			console.log(`Invitation (valid 24 hours): ${link}`);
		} else if (command === "operator") {
			await grantOperator(pool, email);
			console.log("Operator access granted to the selected account");
		} else throw new Error("Unknown container command");
	} finally {
		await pool.end();
	}
}
