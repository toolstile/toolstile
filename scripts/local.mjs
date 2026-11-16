import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"data-dir": {
			type: "string",
			default:
				process.env.TOOLSTILE_DATA_DIR ??
				join(homedir(), ".local", "share", "toolstile"),
		},
		origin: { type: "string", default: "http://127.0.0.1:4310" },
		listen: { type: "string", default: "127.0.0.1" },
		port: { type: "string", default: "4310" },
	},
});
const [command, argument] = positionals;
const directory = resolve(values["data-dir"]);
const configuration = join(directory, "instance.json");
const database = `pglite:${join(directory, "pglite")}`;
if (command === "init") {
	if (!existsSync(configuration)) {
		const origin = new URL(values.origin);
		const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
			origin.hostname,
		);
		if (
			(origin.protocol !== "https:" &&
				!(origin.protocol === "http:" && loopback)) ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash
		)
			throw new Error("Use an HTTPS origin, or HTTP on loopback only");
		const lan = !["127.0.0.1", "::1"].includes(values.listen);
		if (lan && origin.protocol !== "https:")
			throw new Error(
				"LAN serving requires an explicit HTTPS origin and a TLS reverse proxy",
			);
		const port = Number(values.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error("Invalid listening port");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(
			configuration,
			`${JSON.stringify(
				{
					version: 1,
					origin: origin.origin,
					host: values.listen,
					port,
					authSecret: randomBytes(32).toString("hex"),
					encryptionKey: randomBytes(32).toString("hex"),
				},
				null,
				2,
			)}\n`,
			{ flag: "wx", mode: 0o600 },
		);
	}
	await run("apps/web/scripts/migrate.ts", [], { cwd: join(root, "apps/web") });
	console.log(`Instance initialized in ${directory}`);
} else if (command === "start") {
	const entry = join(root, "apps/web/.output/server/index.mjs");
	if (!existsSync(entry)) throw new Error("Build first with vp run build");
	await run("apps/web/scripts/migrate.ts", [], { cwd: join(root, "apps/web") });
	await run(entry, [], { typescript: false });
} else if (command === "bootstrap" || command === "operator") {
	if (!argument?.includes("@"))
		throw new Error(
			`Usage: node scripts/local.mjs ${command} email@example.com`,
		);
	await run(`apps/web/scripts/${command}.ts`, [argument]);
} else if (command === "backup" || command === "restore") {
	if (!argument)
		throw new Error(
			`Usage: node scripts/local.mjs ${command} /absolute/backup-directory --data-dir /absolute/instance-directory`,
		);
	await run("scripts/local-storage.ts", [
		command,
		resolve(argument),
		directory,
	]);
} else {
	throw new Error(
		"Usage: node scripts/local.mjs init|start|bootstrap|operator|backup|restore [argument] [--data-dir path]",
	);
}

function environment() {
	// Restore validates its own source and refuses an existing target; it needs no target key.
	if (command === "restore") return { ...process.env };
	if (!existsSync(configuration))
		throw new Error("Initialize the instance first");
	const config = JSON.parse(readFileSync(configuration, "utf8"));
	if (
		config.version !== 1 ||
		!/^[a-f0-9]{64}$/.test(config.authSecret) ||
		!/^[a-f0-9]{64}$/.test(config.encryptionKey)
	)
		throw new Error("Invalid local instance configuration");
	return {
		...process.env,
		DATABASE_URL: database,
		BETTER_AUTH_URL: config.origin,
		BETTER_AUTH_SECRET: config.authSecret,
		ENCRYPTION_KEY: config.encryptionKey,
		HOST: config.host,
		PORT: String(config.port),
		TOOLSTILE_CATALOG_FETCH: process.env.TOOLSTILE_CATALOG_FETCH ?? "off",
	};
}
async function run(script, args, { cwd = root, typescript = true } = {}) {
	const child = spawn(
		process.execPath,
		[
			...(typescript
				? ["--import", fileURLToPath(import.meta.resolve("tsx"))]
				: []),
			resolve(root, script),
			...args,
		],
		{ cwd, env: environment(), stdio: "inherit" },
	);
	const forward = (signal) => child.kill(signal);
	const term = () => forward("SIGTERM"),
		interrupt = () => forward("SIGINT");
	process.on("SIGTERM", term);
	process.on("SIGINT", interrupt);
	try {
		await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) =>
				code === 0
					? resolve()
					: reject(new Error(`Local ${command} failed (${signal ?? code})`)),
			);
		});
	} finally {
		process.off("SIGTERM", term);
		process.off("SIGINT", interrupt);
	}
}
