import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Drives the built single executable through the local instance lifecycle with an
// empty environment, so nothing from the source checkout or the host's Node.js helps.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = `toolstile-server-${process.platform}-${process.arch}`;
const built = join(root, "dist", name);
if (!existsSync(built)) throw new Error("Build first with vp run build:binary");
const [digest] = readFileSync(`${built}.sha256`, "utf8").split(" ");
if (createHash("sha256").update(readFileSync(built)).digest("hex") !== digest)
	throw new Error("The executable does not match its checksum");

const execute = promisify(execFile);
const environment = { HOME: tmpdir(), PATH: "/usr/bin:/bin" };
const work = mkdtempSync(join(tmpdir(), "toolstile-binary-"));
// Run a copy outside the checkout: beside the source, a missed bundling would still
// resolve packages from its node_modules and pass.
const binary = join(work, name);
copyFileSync(built, binary);
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
	const { stdout: invite } = await run("bootstrap", "owner@example.com");
	const link = invite.match(/(http:\/\/\S+)/)?.[1];
	if (!link?.startsWith(`${origin}/api/auth/accept-invitation/ts_`))
		throw new Error("bootstrap printed no invitation link");
	await fails("operator", "owner@example.com");

	server = spawn(binary, ["start", "--data-dir", data], {
		env: environment,
		cwd: work,
		stdio: ["ignore", "inherit", "inherit"],
	});
	const exited = new Promise((resolve) => server.once("exit", resolve));
	await ready(origin);
	const signIn = await fetch(`${origin}/auth/sign-in`);
	const page = await signIn.text();
	const script = page.match(/\/assets\/[^"]+\.js/)?.[0];
	if (!signIn.ok || !script) throw new Error("The sign-in page did not render");
	const asset = await fetch(`${origin}${script}`);
	if (!asset.ok || !asset.headers.get("content-type")?.includes("javascript"))
		throw new Error("An embedded static asset was not served");
	const mcp = await fetch(`${origin}/mcp`, { method: "POST" });
	if (mcp.status !== 401)
		throw new Error(`Unauthenticated MCP returned ${mcp.status}`);
	const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({
			name: "Owner",
			email: "owner@example.com",
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
	console.log(`${name} ${version.trim()}: lifecycle passed`);
} finally {
	server?.kill("SIGKILL");
	rmSync(work, { recursive: true, force: true });
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
