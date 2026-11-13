import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { createAuth } from "../../auth/src/index";
import { migrateDatabase, openDatabase, user } from "../src/index";

test("PGlite persists the PostgreSQL schema, auth, dates and JSON across restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "toolstile-pglite-"));
	let database = openDatabase(`pglite:${directory}/db`);
	try {
		await migrateDatabase(database.db, {
			migrationsFolder: "apps/web/postgres-migrations",
		});
		await migrateDatabase(database.db, {
			migrationsFolder: "apps/web/postgres-migrations",
		});
		const auth = createAuth({
			database: database.db,
			schema: await import("../src/schema").then((m) => m.authSchema),
			baseURL: "http://localhost:4311",
			secret: "pglite-acceptance-secret-32-characters",
			canRegister: async () => true,
		});
		const result = await auth.api.signUpEmail({
			body: {
				name: "Portable User",
				email: "portable@example.test",
				password: "pglite-acceptance-password",
			},
		});
		const [person] = await database.db
			.select()
			.from(user)
			.where(eq(user.id, result.user.id));
		expect(person.createdAt).toBeInstanceOf(Date);
		expect(person.emailVerified).toBe(false);
		await database.pool.query(
			"INSERT INTO connector_requests(owner_id,scope_id,request_id,fingerprint,response) VALUES($1,$1,$1,$1,$2)",
			["fixture", JSON.stringify({ ok: true })],
		);
		await database.pool.end();
		database = openDatabase(`pglite:${directory}/db`);
		expect(
			(await database.pool.query("SELECT response FROM connector_requests"))
				.rows[0].response,
		).toEqual({ ok: true });
		expect(
			(await database.pool.query('SELECT "createdAt" FROM "user"')).rows[0]
				.createdAt,
		).toBeInstanceOf(Date);
	} finally {
		await database.pool.end();
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
