import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createClient } from "../packages/api/src/client.ts";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "toolstile-container-"));
const project = `toolstile-container-${process.pid}-${randomBytes(4).toString("hex")}`;
const image = process.env.TOOLSTILE_TEST_IMAGE ?? "toolstile:local";
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
const env = {
	...process.env,
	BETTER_AUTH_URL: origin,
	TOOLSTILE_IMAGE: image,
	TOOLSTILE_SECRETS_DIR: directory,
	TOOLSTILE_PORT: String(port),
};
const args = [
	"compose",
	"--project-directory",
	root,
	"-f",
	join(root, "compose.yaml"),
	"-p",
	project,
];
const compose = async (...extra) =>
	(
		await exec("docker", [...args, ...extra], {
			env,
			maxBuffer: 4 * 1024 * 1024,
		})
	).stdout;
let client;
let stream;
try {
	const password = randomBytes(32).toString("hex");
	for (const [name, value] of Object.entries({
		postgres_password: password,
		database_url: `postgresql://toolstile:${password}@postgres:5432/toolstile`,
		auth_secret: randomBytes(32).toString("hex"),
		encryption_key: randomBytes(32).toString("hex"),
	})) {
		await writeFile(join(directory, name), value);
		await chmod(join(directory, name), 0o444);
	}
	await compose("config", "--quiet");
	await compose("up", "-d", "--wait", "postgres");
	await Promise.all([
		compose("run", "--rm", "--no-deps", "app", "migrate"),
		compose("run", "--rm", "--no-deps", "app", "migrate"),
	]);
	await compose("run", "--rm", "--no-deps", "app", "migrate");
	console.log("PASS fresh, concurrent and repeated image migrations");
	await compose(
		"up",
		"-d",
		"--no-build",
		"--wait",
		"--wait-timeout",
		"90",
		"app",
	);
	assert.equal((await fetch(`${origin}/health`)).status, 200);
	assert.equal((await fetch(`${origin}/live`)).status, 200);
	const cid = (await compose("ps", "-q", "app")).trim();
	const details = JSON.parse(
		(await exec("docker", ["inspect", cid])).stdout,
	)[0];
	assert.equal(details.Config.User, "node");
	assert.equal(details.HostConfig.ReadonlyRootfs, true);
	assert.equal(
		(await exec("docker", ["exec", cid, "id", "-u"])).stdout.trim(),
		"1000",
	);
	const auth = async (path, body) =>
		fetch(`${origin}/api/auth/${path}`, {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const email = "container@test.invalid";
	const credentials = {
		email,
		password: "container-acceptance-password-12345",
	};
	assert.equal(
		(await auth("sign-up/email", { ...credentials, name: "Container" })).status,
		403,
	);
	const invitation = await compose(
		"run",
		"--rm",
		"--no-deps",
		"app",
		"bootstrap",
		email,
	);
	const invitationToken = invitation.match(
		/accept-invitation\/(ts_[\w-]+)/,
	)?.[1];
	assert.ok(invitationToken, "bundled bootstrap returns an invitation");
	const signup = await auth("sign-up/email", {
		...credentials,
		name: "Container",
		invitationToken,
	});
	assert.equal(signup.status, 200);
	let cookie = signup.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const api = createClient(`${origin}/api/rpc`, () => ({ cookie, origin }));
	await compose("run", "--rm", "--no-deps", "app", "operator", email);
	const device = await api.addDevice({ label: "Container device" });
	const agent = await api.addAgent({
		label: "Container agent",
		deviceId: device.id,
		expiresInDays: null,
	});
	const connect = async () => {
		const current = new Client({ name: "container-acceptance", version: "1" });
		await current.connect(
			new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
				requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
			}),
		);
		assert.ok(
			(await current.listTools()).tools.some((t) => t.name === "get_my_access"),
		);
		assert.notEqual(
			(await current.callTool({ name: "get_my_access", arguments: {} }))
				.isError,
			true,
		);
		return current;
	};
	client = await connect();
	const challenge = await fetch(`${origin}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	assert.equal(challenge.status, 401);
	assert.ok(
		challenge.headers
			.get("www-authenticate")
			?.includes("oauth-protected-resource"),
	);
	const metadata = await fetch(
		`${origin}/.well-known/oauth-protected-resource/mcp`,
	).then((r) => r.json());
	assert.equal(metadata.resource, `${origin}/mcp`);
	console.log(
		"PASS non-root/read-only image, invitation/password auth, operator CLI, MCP SDK initialize/list/call and OAuth challenge",
	);
	await client.close();
	client = undefined;
	// Hold a legacy session SSE response open during SIGTERM. The server must
	// close it itself, rather than waiting for the orchestrator's SIGKILL.
	const headers = {
		Authorization: `Bearer ${agent.token}`,
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	const initialized = await fetch(`${origin}/mcp`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "shutdown", version: "1" },
			},
		}),
	});
	assert.equal(initialized.status, 200);
	const session = initialized.headers.get("mcp-session-id");
	await initialized.text();
	assert.ok(session);
	const streamResponse = await fetch(`${origin}/mcp`, {
		headers: {
			...headers,
			"Mcp-Session-Id": session,
			"MCP-Protocol-Version": "2025-03-26",
		},
	});
	assert.equal(streamResponse.status, 200);
	stream = streamResponse.body.getReader();
	const streamClosed = (async () => {
		try {
			while (!(await stream.read()).done) {
				/* drain */
			}
		} catch {
			/* network closes on stop */
		}
	})();
	const before = Date.now();
	await compose("stop", "app");
	await Promise.race([
		streamClosed,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("SSE did not close")), 3000).unref(),
		),
	]);
	assert.ok(
		Date.now() - before < 10000,
		"streams and cleanup finish before srvx forced-close fallback",
	);
	const stopped = JSON.parse(
		(await exec("docker", ["inspect", cid])).stdout,
	)[0];
	assert.equal(stopped.State.ExitCode, 0, "clean SIGTERM exit");
	console.log("PASS graceful shutdown with an active SSE stream");
	await compose("up", "-d", "--no-deps", "--wait", "app");
	const signin = await auth("sign-in/email", credentials);
	assert.equal(signin.status, 200);
	cookie = signin.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	assert.ok((await api.snapshot()).devices.some((d) => d.id === device.id));
	client = await connect();
	await client.close();
	client = undefined;
	await compose("restart", "postgres");
	await compose("up", "-d", "--wait", "postgres");
	const deadline = Date.now() + 20000;
	while ((await fetch(`${origin}/health`)).status !== 200) {
		if (Date.now() > deadline) throw new Error("Readiness did not recover");
		await new Promise((done) => setTimeout(done, 100));
	}
	await compose("stop", "postgres");
	assert.equal(
		(await fetch(`${origin}/health`, { signal: AbortSignal.timeout(4000) }))
			.status,
		503,
	);
	assert.equal((await fetch(`${origin}/live`)).status, 200);
	await compose("up", "-d", "--wait", "postgres");
	// Crash the owned Node process inside its container. `docker kill` marks a
	// manual stop, so it cannot prove unless-stopped's automatic recovery.
	const priorRestarts = JSON.parse(
		(await exec("docker", ["inspect", cid])).stdout,
	)[0].RestartCount;
	await exec("docker", [
		"exec",
		cid,
		"node",
		"--input-type=module",
		"-e",
		`
import {readdirSync,readFileSync} from 'node:fs';
for (const pid of readdirSync('/proc').filter(p=>/^\\d+$/.test(p))) {
 try { if (readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').includes('.output/server/index.mjs')) process.kill(Number(pid),'SIGKILL'); } catch {}
}`,
	]);
	const restartDeadline = Date.now() + 15000;
	for (;;) {
		const state = JSON.parse(
			(await exec("docker", ["inspect", cid])).stdout,
		)[0];
		if (
			state.RestartCount > priorRestarts &&
			(await fetch(`${origin}/health`).then(
				(r) => r.ok,
				() => false,
			))
		)
			break;
		if (Date.now() > restartDeadline)
			throw new Error("Restart policy did not recover the crashed process");
		await new Promise((done) => setTimeout(done, 100));
	}
	assert.equal((await auth("sign-in/email", credentials)).status, 200);

	console.log(
		"PASS app/database restarts, persisted auth/agents, readiness failure/recovery and forced process restart",
	);
	// Exercise the documented manual logical-backup path into a different DB;
	// original data remains intact until disposal of this owned test project.
	await compose("stop", "app");
	const archive = (
		await exec(
			"docker",
			[
				...args,
				"exec",
				"-T",
				"postgres",
				"pg_dump",
				"-U",
				"toolstile",
				"-d",
				"toolstile",
				"-Fc",
			],
			{ env, encoding: "buffer" },
		)
	).stdout;
	assert.ok(archive.length > 1000);
	await compose(
		"exec",
		"-T",
		"postgres",
		"createdb",
		"-U",
		"toolstile",
		"restored",
	);
	await new Promise((done, reject) => {
		const restore = spawn(
			"docker",
			[
				...args,
				"exec",
				"-T",
				"postgres",
				"pg_restore",
				"-U",
				"toolstile",
				"-d",
				"restored",
				"--no-owner",
				"--exit-on-error",
			],
			{ env, stdio: ["pipe", "ignore", "pipe"] },
		);
		restore.once("error", reject);
		restore.stdin.on("error", reject);
		restore.once("exit", (code) =>
			code === 0 ? done() : reject(new Error("Manual restore failed")),
		);
		restore.stdin.end(archive);
	});
	const urlFile = join(directory, "database_url");
	await chmod(urlFile, 0o600);
	await writeFile(
		urlFile,
		`postgresql://toolstile:${password}@postgres:5432/restored`,
	);
	await chmod(urlFile, 0o444);
	await compose("run", "--rm", "--no-deps", "app", "migrate");
	await compose("up", "-d", "--no-deps", "--force-recreate", "--wait", "app");
	assert.equal((await auth("sign-in/email", credentials)).status, 200);
	client = await connect();
	await client.close();
	client = undefined;
	console.log(
		"PASS manual pg_dump/pg_restore into an isolated database with matching keys, password auth and MCP credentials",
	);
} finally {
	await client?.close().catch(() => {});
	await stream?.cancel().catch(() => {});
	await compose("down", "--volumes", "--remove-orphans");
	await rm(directory, { recursive: true, force: true });
}
