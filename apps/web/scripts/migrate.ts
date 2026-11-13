import { migrateDatabaseWithLock, openDatabase } from "@toolstile/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations");
const { pool } = openDatabase(databaseUrl);
try {
	await migrateDatabaseWithLock(pool, {
		migrationsFolder: "./postgres-migrations",
	});
	console.log("Migrations applied");
} finally {
	await pool.end();
}
