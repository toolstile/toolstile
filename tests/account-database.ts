import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import * as schema from "../apps/web/src/server/schema";
import { migrateDatabase, openDatabase } from "../packages/database/src/index";

export async function createAccountTestDatabase() {
	const directory = await mkdtemp(join(tmpdir(), "toolstile-account-"));
	let file = join(directory, "pglite");
	let admin: pg.Pool | undefined;
	const databaseName = `core_fixture_${randomUUID().replaceAll("-", "")}`;
	if (process.env.TEST_DATABASE_URL?.startsWith("postgres")) {
		admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
		await admin.query(`CREATE DATABASE "${databaseName}"`);
		const url = new URL(process.env.TEST_DATABASE_URL);
		url.pathname = `/${databaseName}`;
		file = url.href;
	}
	const storage = openDatabase(file, { schema });
	try {
		await migrateDatabase(storage.db, {
			migrationsFolder: "apps/web/postgres-migrations",
		});
	} catch (error) {
		await storage.pool.end();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	return {
		url: file,
		...storage,
		async close() {
			await storage.pool.end();
			if (admin) {
				await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
				await admin.end();
			}
			await rm(directory, { recursive: true, force: true });
		},
	};
}
export function accountTestEnv(name: string) {
	const value = process.env[name];
	if (!value)
		throw new Error(`${name} is required for account integration tests`);
	return value;
}
