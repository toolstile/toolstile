import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
	createSetupAccount,
	issueSetupLink,
	offersSetupLink,
	setupLinkUsable,
} from "../apps/web/src/server/setup-link";
import { migrateDatabase, openDatabase } from "../packages/database/src/index";
import { startMessage } from "../scripts/local-commands";
import { createAccountTestDatabase } from "./account-database";

const execute = promisify(execFile);
const directories: string[] = [];
const servers: ChildProcess[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await stop(server);
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
async function temporary() {
	const directory = await mkdtemp(join(tmpdir(), "toolstile-setup-link-"));
	directories.push(directory);
	return directory;
}
async function database() {
	const { db, pool } = openDatabase(`pglite:${await temporary()}`);
	await migrateDatabase(db, {
		migrationsFolder: "apps/web/postgres-migrations",
	});
	return pool;
}
const owner = (email = "owner@test.invalid") => ({
	email,
	name: "owner",
	passwordHash: "not-a-real-hash",
});
test("a setup link works once and only while the instance has no accounts", async () => {
	const pool = await database();
	try {
		const token = await issueSetupLink(pool);
		expect(token).toMatch(/^[\w-]{43}$/);
		expect(await setupLinkUsable(pool, token ?? "")).toBe(true);
		expect(await createSetupAccount(pool, "", owner())).toBeUndefined();
		expect(
			await createSetupAccount(pool, `${token}x`, owner()),
		).toBeUndefined();
		const id = await createSetupAccount(pool, token ?? "", owner());
		expect(
			(
				await pool.query(
					`select u.email, p.operator, a."providerId" from "user" u join profiles p on p."userId"=u.id join account a on a."userId"=u.id where u.id=$1`,
					[id],
				)
			).rows,
		).toEqual([
			{ email: "owner@test.invalid", operator: true, providerId: "credential" },
		]);
		expect(
			await createSetupAccount(pool, token ?? "", owner("second@test.invalid")),
		).toBeUndefined();
		expect(await setupLinkUsable(pool, token ?? "")).toBe(false);
		expect(await issueSetupLink(pool)).toBeUndefined();
		expect((await pool.query("select 1 from setup_link")).rowCount).toBe(0);
	} finally {
		await pool.end();
	}
});

test("a setup link expires after 15 minutes and a reissued link replaces it", async () => {
	const pool = await database();
	try {
		const first = await issueSetupLink(pool);
		const {
			rows: [row],
		} = await pool.query(
			`select "expiresAt" - clock_timestamp() between interval '14 minutes' and interval '15 minutes' as fresh from setup_link`,
		);
		expect(row?.fresh).toBe(true);
		const second = await issueSetupLink(pool);
		expect(second).not.toBe(first);
		expect(
			await createSetupAccount(pool, first ?? "", owner()),
		).toBeUndefined();
		await pool.query(
			`update setup_link set "expiresAt"=clock_timestamp() - interval '1 second'`,
		);
		expect(
			await createSetupAccount(pool, second ?? "", owner()),
		).toBeUndefined();
		expect((await pool.query('select 1 from "user"')).rowCount).toBe(0);
	} finally {
		await pool.end();
	}
});

test("only a loopback instance on a plain HTTP loopback origin offers a setup link", () => {
	for (const origin of [
		"http://127.0.0.1:4310",
		"http://localhost:4310",
		"http://[::1]:4310",
	]) {
		expect(offersSetupLink(origin, "127.0.0.1")).toBe(true);
		expect(offersSetupLink(origin, "::1")).toBe(true);
		expect(offersSetupLink(origin, "0.0.0.0")).toBe(false);
		expect(offersSetupLink(origin, "192.168.1.2")).toBe(false);
	}
	expect(offersSetupLink("https://gateway.example.com", "127.0.0.1")).toBe(
		false,
	);
	expect(offersSetupLink("https://localhost:4310", "127.0.0.1")).toBe(false);
	expect(offersSetupLink("http://192.168.1.2:4310", "127.0.0.1")).toBe(false);
});

test("the printed connect command quotes an IPv6 address for the shell", () => {
	expect(startMessage("http://[::1]:4310", "token")).toContain(
		"claude mcp add --transport http toolstile 'http://[::1]:4310/mcp'\n",
	);
	expect(startMessage("http://127.0.0.1:4310", "token")).toContain(
		"claude mcp add --transport http toolstile http://127.0.0.1:4310/mcp\n",
	);
});

// Two connections are needed to interleave the registrations, so this runs on PostgreSQL.
test.skipIf(!process.env.TEST_DATABASE_URL)(
	"an invited sign-up racing the setup link never gains operator access",
	async () => {
		const storage = await createAccountTestDatabase();
		const invited = await storage.pool.connect();
		try {
			const token = await issueSetupLink(storage.pool);
			// The invited account is inserted but not yet committed when the setup runs.
			await invited.query("begin");
			await invited.query(
				'insert into "user"(id,name,email) values($1,$2,$3)',
				["invited", "Invited", "owner@test.invalid"],
			);
			const setup = createSetupAccount(
				storage.pool,
				token ?? "",
				owner(),
			).catch(() => undefined);
			await new Promise((done) => setTimeout(done, 500));
			await invited.query("commit");
			expect(await setup).toBeUndefined();
			expect(
				(
					await storage.pool.query(
						'select u.id, p.operator from "user" u left join profiles p on p."userId"=u.id',
					)
				).rows,
			).toEqual([{ id: "invited", operator: null }]);
			expect((await storage.pool.query("select 1 from account")).rowCount).toBe(
				0,
			);
		} finally {
			invited.release();
			await storage.close();
		}
	},
);

/** The production server alone, on PGlite, as `start` would run it but with `env`. */
async function production(env: Record<string, string>) {
	const port = await freePort();
	const server = spawn(
		process.execPath,
		["apps/web/.output/server/index.mjs"],
		{
			env: {
				...process.env,
				BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
				ENCRYPTION_KEY: randomBytes(32).toString("hex"),
				HOST: "127.0.0.1",
				PORT: String(port),
				NODE_ENV: "production",
				TOOLSTILE_CATALOG_FETCH: "off",
				...env,
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	servers.push(server);
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;
	while (
		!(await fetch(`${base}/health`).then(
			(response) => response.ok,
			() => false,
		))
	) {
		if (server.exitCode !== null || Date.now() > deadline)
			throw new Error("The production server did not become ready");
		await new Promise((done) => setTimeout(done, 100));
	}
	return base;
}

test("the server refuses a setup link when the instance is not loopback-only", async () => {
	const directory = await temporary();
	let token: string | undefined;
	const { db, pool: instance } = openDatabase(`pglite:${directory}`);
	try {
		await migrateDatabase(db, {
			migrationsFolder: "apps/web/postgres-migrations",
		});
		token = await issueSetupLink(instance);
	} finally {
		await instance.end();
	}
	// An HTTPS origin is reached through a proxy, so `start` never offers it a link.
	const origin = "https://gateway.example.test";
	const base = await production({
		DATABASE_URL: `pglite:${directory}`,
		BETTER_AUTH_URL: origin,
	});
	const response = await fetch(`${base}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({
			email: "owner@example.com",
			password: "setup-link-test-password",
			setupToken: token,
		}),
	});
	expect(response.status).toBe(403);
	expect((await response.json()).code).toBe("SETUP_LINK_UNAVAILABLE");
}, 60_000);

const local = (data: string, ...args: string[]) =>
	execute(process.execPath, ["scripts/local.mjs", ...args, "--data-dir", data]);

async function freePort() {
	const probe = createServer();
	await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	await new Promise((done) => probe.close(done));
	return address.port;
}

/** `start` from the source checkout; resolves with what it printed once it is serving. */
async function start(data: string, env: Record<string, string> = {}) {
	const server = spawn(
		process.execPath,
		["scripts/local.mjs", "start", "--data-dir", data],
		{ env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
	);
	servers.push(server);
	let output = "";
	server.stdout?.on("data", (chunk) => (output += chunk));
	server.stderr?.on("data", (chunk) => (output += chunk));
	const deadline = Date.now() + 60_000;
	while (!output.includes("Toolstile is running at")) {
		if (server.exitCode !== null || Date.now() > deadline)
			throw new Error(`start did not report readiness: ${output}`);
		await new Promise((done) => setTimeout(done, 100));
	}
	return { server, output };
}

async function stop(server: ChildProcess) {
	if (server.exitCode !== null || server.signalCode !== null) return;
	const exited = new Promise((done) => server.once("exit", done));
	server.kill("SIGTERM");
	const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
	await exited;
	clearTimeout(force);
}

function setupSignUp(
	origin: string,
	token: string,
	email: string,
	from = origin,
) {
	return fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: from },
		body: JSON.stringify({
			email,
			password: "setup-link-test-password",
			setupToken: token,
		}),
	});
}

/** fetch cannot name another Host, so use node:http. */
function withHost(origin: string, path: string, host: string) {
	return new Promise<number>((done, reject) => {
		const url = new URL(path, origin);
		request(
			{
				host: url.hostname,
				port: url.port,
				path: url.pathname,
				headers: { host },
			},
			(response) => {
				response.resume();
				done(response.statusCode ?? 0);
			},
		)
			.once("error", reject)
			.end();
	});
}

test("start prints a setup link that creates the operator account once", async () => {
	const data = join(await temporary(), "instance");
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	await local(data, "init", "--port", String(port));
	const link = (output: string) =>
		output.match(/\/auth\/setup#([\w-]+)\n/)?.[1] ?? "";

	// An inherited Nitro bind must not move the server off the instance's address.
	const first = await start(data, { NITRO_PORT: String(await freePort()) });
	expect(first.output).toContain(`
Toolstile is running at ${origin}

Finish setup (link works once, expires in 15 minutes):
  ${origin}/auth/setup#${link(first.output)}

Then connect Claude Code:
  claude mcp add --transport http toolstile ${origin}/mcp
`);
	const page = await fetch(`${origin}/auth/setup`);
	const script = (await page.text()).match(/\/assets\/[^"]+\.js/)?.[0] ?? "";
	expect(page.status).toBe(200);
	// Nitro serves static assets before the application; the Host check runs ahead of both.
	expect(await withHost(origin, script, "localhost")).toBe(421);
	expect(await withHost(origin, script, `127.0.0.1:${port}`)).toBe(200);
	// DNS rebinding: a page whose own name resolves to loopback still sends its Host.
	expect(await withHost(origin, "/auth/setup", `rebound.example:${port}`)).toBe(
		421,
	);
	expect(await withHost(origin, "/api/auth/get-session", "localhost")).toBe(
		421,
	);
	expect(await withHost(origin, "/health", "container:3000")).toBe(200);
	const foreign = await setupSignUp(
		origin,
		link(first.output),
		"owner@example.com",
		"http://rebound.example",
	);
	await foreign.body?.cancel();
	expect(foreign.status).toBe(403);
	await stop(first.server);

	// Each start reissues the link while there are still no accounts.
	const second = await start(data);
	expect(link(second.output)).not.toBe(link(first.output));
	const stale = await setupSignUp(
		origin,
		link(first.output),
		"owner@example.com",
	);
	expect(stale.status).toBe(403);
	expect((await stale.json()).code).toBe("SETUP_LINK_UNAVAILABLE");
	const created = await setupSignUp(
		origin,
		link(second.output),
		"Owner@Example.com",
	);
	expect(created.status).toBe(200);
	expect(created.headers.getSetCookie().join(";")).toContain("session_token=");
	await created.body?.cancel();
	const reused = await setupSignUp(
		origin,
		link(second.output),
		"second@example.com",
	);
	await reused.body?.cancel();
	expect(reused.status).toBe(403);
	await stop(second.server);

	const { pool } = openDatabase(`pglite:${join(data, "pglite")}`);
	try {
		expect(
			(
				await pool.query(
					'select u.email, p.operator from "user" u join profiles p on p."userId"=u.id',
				)
			).rows,
		).toEqual([{ email: "owner@example.com", operator: true }]);
	} finally {
		await pool.end();
	}

	// With an account, start offers no setup link.
	const third = await start(data);
	expect(third.output).toContain(`Toolstile is running at ${origin}\n`);
	expect(third.output).not.toContain("Finish setup");
}, 180_000);
