import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeEnvironment } from "./local-environment.mjs";

process.chdir(dirname(dirname(fileURLToPath(import.meta.url))));
const directory = mkdtempSync(join(tmpdir(), "toolstile-postgres-test-"));
const reservation = createServer();
await new Promise((done, reject) => {
	reservation.once("error", reject);
	reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
const environment = {
	...runtimeEnvironment(),
	BETTER_AUTH_URL: origin,
	BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
	ENCRYPTION_KEY: randomBytes(32).toString("hex"),
	TOOLSTILE_CATALOG_FETCH: "off",
	HOST: "127.0.0.1",
	PORT: String(port),
	NODE_ENV: "test",
	TEST_BASE_URL: origin,
};
const container = `toolstile-core-test-${process.pid}`;
let server;
let databaseContainer;
// Interrupts stop the running step; the finally block still removes the fixture.
const children = new Set();
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		interrupted = signal;
		for (const child of children) child.kill(signal);
		server?.kill("SIGTERM");
	});
function checkInterrupted() {
	if (interrupted)
		throw new Error(`Postgres check interrupted (${interrupted})`);
}
// An optional run label lets a calling harness remove the container after a hard kill.
const runLabel = /^[a-z0-9-]{8,64}$/.test(process.env.TOOLSTILE_CI_RUN ?? "")
	? ["--label", `toolstile.ci-run=${process.env.TOOLSTILE_CI_RUN}`]
	: [];

try {
	execFileSync(
		"docker",
		[
			"run",
			"--detach",
			"--name",
			container,
			...runLabel,
			"--env",
			"POSTGRES_PASSWORD=fixture",
			"--publish",
			"127.0.0.1::5432",
			"postgres:17.6-alpine",
		],
		{ stdio: "pipe" },
	);
	databaseContainer = true;
	const published = execFileSync("docker", ["port", container, "5432/tcp"], {
		encoding: "utf8",
	}).trim();
	const databaseUrl = `postgresql://postgres:fixture@127.0.0.1:${published.split(":").at(-1)}/postgres`;
	environment.DATABASE_URL = databaseUrl;
	environment.TEST_DATABASE_URL = databaseUrl;
	const readyDeadline = Date.now() + 30000;
	for (;;) {
		try {
			execFileSync(
				"docker",
				["exec", container, "pg_isready", "-U", "postgres"],
				{ stdio: "pipe" },
			);
			break;
		} catch {
			checkInterrupted();
			if (Date.now() > readyDeadline)
				throw new Error("Postgres fixture not ready");
			await new Promise((done) => setTimeout(done, 100));
		}
	}
	// Competing migrators and repeat application exercise the actual file locking/journal.
	const migrations = await Promise.allSettled([
		run("pnpm", ["db:migrate"]),
		run("pnpm", ["db:migrate"]),
	]);
	for (const result of migrations)
		if (result.status === "rejected") throw result.reason;
	await run("pnpm", ["db:migrate"]);
	if (!process.argv.includes("--migrations-only")) {
		const entry = resolve("apps/web/.output/server/index.mjs");
		if (!existsSync(entry))
			throw new Error("Run pnpm build before the Postgres HTTP suite");
		server = spawn(process.execPath, [entry], {
			env: environment,
			stdio: ["ignore", "ignore", "inherit"],
		});
		const deadline = Date.now() + 15_000;
		for (;;) {
			checkInterrupted();
			if (server.exitCode !== null)
				throw new Error("Postgres HTTP fixture exited before readiness");
			if (
				await fetch(`${origin}/health`).then(
					(response) => response.ok,
					() => false,
				)
			)
				break;
			if (Date.now() >= deadline)
				throw new Error("Postgres HTTP fixture did not become ready");
			await new Promise((done) => setTimeout(done, 100));
		}
		console.log(`Disposable Postgres HTTP fixture: ${origin}`);
		const report = join(directory, "tests.json");
		await run("pnpm", [
			"exec",
			"vitest",
			"run",
			...process.argv.slice(2),
			"--reporter=default",
			"--reporter=json",
			`--outputFile=${report}`,
		]);
		const result = JSON.parse(readFileSync(report, "utf8"));
		if (
			!result.numTotalTests ||
			result.numPendingTests ||
			result.numTodoTests ||
			result.numFailedTests
		)
			throw new Error(
				"Postgres acceptance requires a nonempty suite without failures, skips or todos",
			);
	}
} finally {
	if (server && server.exitCode === null) {
		const exited = new Promise((done) => server.once("exit", done));
		server.kill("SIGTERM");
		const force = setTimeout(() => server.kill("SIGKILL"), 5_000);
		await exited;
		clearTimeout(force);
	}
	if (databaseContainer)
		execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
	rmSync(directory, { recursive: true, force: true });
}
function run(command, args) {
	return new Promise((done, reject) => {
		checkInterrupted();
		const child = spawn(command, args, { env: environment, stdio: "inherit" });
		children.add(child);
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			children.delete(child);
			code === 0
				? done()
				: reject(new Error(`Postgres check failed (${signal ?? code})`));
		});
	});
}
