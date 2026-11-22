import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliDecompressSync } from "node:zlib";

// Drives the built single executable through the local instance lifecycle with an
// empty environment, so nothing from the source checkout or the host's Node.js helps.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = `toolstile-server-${process.platform}-${process.arch}`;
const built = join(root, "dist", name);
if (!existsSync(built)) throw new Error("Build first with vp run build:binary");
// A release build (--compress) publishes the .br file, so test the bytes it decompresses to.
const executable = existsSync(`${built}.br`)
	? brotliDecompressSync(readFileSync(`${built}.br`))
	: readFileSync(built);
const [digest] = readFileSync(`${built}.sha256`, "utf8").split(" ");
if (createHash("sha256").update(executable).digest("hex") !== digest)
	throw new Error("The executable does not match its checksum");

const execute = promisify(execFile);
const environment = { HOME: tmpdir(), PATH: "/usr/bin:/bin" };
const work = mkdtempSync(join(tmpdir(), "toolstile-binary-"));
// Run a copy outside the checkout: beside the source, a missed bundling would still
// resolve packages from its node_modules and pass.
const binary = join(work, name);
writeFileSync(binary, executable);
chmodSync(binary, 0o755);
const data = join(work, "instance");
const run = (...args) =>
	execute(binary, [...args, "--data-dir", data], {
		env: environment,
		cwd: work,
	});
const fails = (...args) =>
	run(...args).then(
		() => {
			throw new Error(`${args[0]} unexpectedly succeeded`);
		},
		() => {},
	);
const port = await new Promise((resolve) => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});
const origin = `http://127.0.0.1:${port}`;
let server;
try {
	await fails(
		"init",
		"--origin",
		"http://192.168.1.2:4310",
		"--listen",
		"0.0.0.0",
	);
	if (existsSync(data)) throw new Error("A refused init created the instance");
	await run("init", "--origin", origin, "--port", String(port));
	const { stdout: invite } = await run("bootstrap", "member@example.com");
	const link = invite.match(/(http:\/\/\S+)/)?.[1];
	if (!link?.startsWith(`${origin}/api/auth/accept-invitation/ts_`))
		throw new Error("bootstrap printed no invitation link");
	await fails("operator", "owner@example.com");

	server = spawn(binary, ["start", "--data-dir", data], {
		env: environment,
		cwd: work,
		stdio: ["ignore", "pipe", "inherit"],
	});
	const exited = new Promise((resolve) => server.once("exit", resolve));
	let output = "";
	server.stdout.on("data", (chunk) => {
		output += chunk;
		process.stdout.write(chunk);
	});
	await ready(origin);
	// An instance without accounts prints its one-time setup link once it is listening.
	const deadline = Date.now() + 30_000;
	while (!output.includes("Then connect Claude Code")) {
		if (Date.now() > deadline) throw new Error("start printed no setup link");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const setupToken = output.match(/\/auth\/setup#([\w-]{43})\n/)?.[1];
	if (
		!setupToken ||
		!output.includes(`
Toolstile is running at ${origin}

Finish setup (link works once, expires in 15 minutes):
  ${origin}/auth/setup#${setupToken}

Then connect Claude Code:
  claude mcp add --transport http toolstile ${origin}/mcp
`)
	)
		throw new Error("start printed an unexpected setup block");
	if ((await hostStatus("/auth/sign-in", `rebound.example:${port}`)) !== 421)
		throw new Error("A request for another host name was served");
	const setupPage = await fetch(`${origin}/auth/setup`);
	await setupPage.body?.cancel();
	if (!setupPage.ok) throw new Error("The setup page did not render");
	const setup = (from, email) =>
		fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: from },
			body: JSON.stringify({
				email,
				password: "binary-smoke-test-password",
				setupToken,
			}),
		});
	const crossSite = await setup("http://rebound.example", "owner@example.com");
	await crossSite.body?.cancel();
	if (crossSite.status !== 403)
		throw new Error(`Cross-site setup returned ${crossSite.status}`);
	const owner = await setup(origin, "owner@example.com");
	await owner.body?.cancel();
	if (!owner.ok) throw new Error(`Setup sign-up returned ${owner.status}`);
	const snapshot = await fetch(`${origin}/api/rpc/snapshot`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			cookie: owner.headers
				.getSetCookie()
				.map((cookie) => cookie.split(";")[0])
				.join("; "),
		},
		body: "{}",
	});
	if (!(await snapshot.text()).includes('"operator":true'))
		throw new Error("The setup account is not the instance operator");
	const again = await setup(origin, "second@example.com");
	await again.body?.cancel();
	if (again.status !== 403)
		throw new Error(`A used setup link returned ${again.status}`);
	const signIn = await fetch(`${origin}/auth/sign-in`);
	const page = await signIn.text();
	const script = page.match(/\/assets\/[^"]+\.js/)?.[0];
	if (!signIn.ok || !script) throw new Error("The sign-in page did not render");
	const asset = await fetch(`${origin}${script}`);
	if (!asset.ok || !asset.headers.get("content-type")?.includes("javascript"))
		throw new Error("An embedded static asset was not served");
	// Nitro serves static assets before the application; the Host check runs ahead of both.
	if ((await hostStatus(script, `rebound.example:${port}`)) !== 421)
		throw new Error("A static asset was served for another host name");
	const mcp = await fetch(`${origin}/mcp`, { method: "POST" });
	if (mcp.status !== 401)
		throw new Error(`Unauthenticated MCP returned ${mcp.status}`);
	const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({
			name: "Member",
			email: "member@example.com",
			password: "binary-smoke-test-password",
			invitationToken: link.split("/").at(-1),
		}),
	});
	await signUp.body?.cancel();
	if (!signUp.ok) throw new Error(`Invited sign-up returned ${signUp.status}`);
	const session = await fetch(`${origin}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({
			email: "owner@example.com",
			password: "binary-smoke-test-password",
		}),
	});
	await session.body?.cancel();
	if (!session.ok) throw new Error(`Sign-in returned ${session.status}`);
	server.kill("SIGINT");
	if ((await exited) !== 0) throw new Error("The server did not stop cleanly");
	server = undefined;

	await run("operator", "owner@example.com");
	const backup = join(work, "backup");
	await run("backup", backup);
	await fails("backup", backup);
	await execute(
		binary,
		["restore", backup, "--data-dir", join(work, "restored")],
		{
			env: environment,
			cwd: work,
		},
	);
	const { stdout: version } = await execute(binary, ["version"], {
		env: environment,
		cwd: work,
	});
	// A release build names its version; the CLI reports it after installing.
	if (
		process.env.TOOLSTILE_VERSION &&
		version.trim() !== process.env.TOOLSTILE_VERSION
	)
		throw new Error(
			`version printed ${version.trim()}, expected ${process.env.TOOLSTILE_VERSION}`,
		);
	console.log(`${name} ${version.trim()}: lifecycle passed`);
} finally {
	server?.kill("SIGKILL");
	rmSync(work, { recursive: true, force: true });
}

/** fetch cannot name another Host, so use node:http. */
function hostStatus(path, host) {
	return new Promise((resolve, reject) => {
		request(
			{ host: "127.0.0.1", port, path, headers: { host } },
			(response) => {
				response.resume();
				resolve(response.statusCode);
			},
		)
			.once("error", reject)
			.end();
	});
}

async function ready(url) {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			if ((await fetch(`${url}/health`)).ok) return;
		} catch {}
		if (Date.now() > deadline)
			throw new Error("The server did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}
