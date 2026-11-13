import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createAuth } from "../packages/auth/src/index";
import {
	authSchema,
	migrateDatabase,
	openDatabase,
} from "../packages/database/src/index";

async function stop(server: ChildProcess) {
	if (server.exitCode !== null) return;
	const exited = new Promise<void>((done) => server.once("exit", () => done()));
	server.kill("SIGTERM");
	const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
	try {
		await exited;
	} finally {
		clearTimeout(force);
	}
}

test("standalone production output opens persistent PGlite and authenticates after restart", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "toolstile-pglite-production-"),
	);
	let server: ChildProcess | undefined;
	try {
		// Run outside the repository so missing traced dependencies cannot resolve from
		// the development node_modules directory and hide an incomplete artifact.
		await cp(resolve("apps/web/.output"), join(directory, ".output"), {
			recursive: true,
		});
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const address = reservation.address();
		if (!address || typeof address === "string")
			throw new Error("No test port");
		const port = address.port;
		await new Promise<void>((done, reject) =>
			reservation.close((error) => (error ? reject(error) : done())),
		);
		const origin = `http://127.0.0.1:${port}`;
		const secret = randomBytes(32).toString("hex");
		const encryptionKey = randomBytes(32).toString("hex");
		const databaseUrl = `pglite:${join(directory, "database")}`;
		const database = openDatabase(databaseUrl);
		try {
			await migrateDatabase(database.db, {
				migrationsFolder: "apps/web/postgres-migrations",
			});
			const auth = createAuth({
				database: database.db,
				schema: authSchema,
				baseURL: origin,
				secret,
				canRegister: async () => true,
			});
			await auth.api.signUpEmail({
				body: {
					name: "Persisted Local User",
					email: "persisted@test.invalid",
					password: "persistent-production-password",
				},
			});
		} finally {
			await database.pool.end();
		}
		for (let restart = 0; restart < 2; restart++) {
			let errors = "";
			server = spawn(
				process.execPath,
				[join(directory, ".output/server/index.mjs")],
				{
					cwd: directory,
					env: {
						...process.env,
						DATABASE_URL: databaseUrl,
						BETTER_AUTH_URL: origin,
						BETTER_AUTH_SECRET: secret,
						ENCRYPTION_KEY: encryptionKey,
						HOST: "127.0.0.1",
						PORT: String(port),
						TOOLSTILE_CATALOG_FETCH: "off",
						NODE_ENV: "production",
					},
					stdio: ["ignore", "ignore", "pipe"],
				},
			);
			server.stderr?.on("data", (chunk) => {
				errors += String(chunk);
			});
			const deadline = Date.now() + 15000;
			for (;;) {
				if (server.exitCode !== null)
					throw new Error(
						`Production server exited before readiness: ${errors}`,
					);
				if (
					await fetch(`${origin}/health`).then(
						(response) => response.ok,
						() => false,
					)
				)
					break;
				if (Date.now() > deadline)
					throw new Error(
						`Production PGlite did not become healthy: ${errors}`,
					);
				await new Promise((done) => setTimeout(done, 50));
			}
			const response = await fetch(`${origin}/api/auth/sign-in/email`, {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "persisted@test.invalid",
					password: "persistent-production-password",
				}),
			});
			expect(response.status).toBe(200);
			expect((await response.json()).user.email).toBe("persisted@test.invalid");
			await stop(server);
			server = undefined;
		}
	} finally {
		if (server) await stop(server);
		await rm(directory, { recursive: true, force: true });
	}
}, 120_000);
