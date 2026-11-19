import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	grantOperator,
	inviteUser,
} from "../apps/web/scripts/admin-operations";
import { openDatabase } from "../packages/database/src/index";
import { migrateDatabaseWithLock } from "../packages/database/src/migrate";
import { backupInstance, restoreInstance } from "./local-storage";

/** What differs between running from a source checkout and the single executable. */
export type LocalRuntime = {
	/** How the user invokes these commands, for usage messages. */
	name: string;
	version: string;
	/** Folder holding the PostgreSQL migrations this release applies. */
	migrationsFolder: () => string;
	/** Load the production server, which listens on HOST and PORT once imported. */
	startServer: () => Promise<unknown>;
};

const commands = [
	"init",
	"start",
	"bootstrap",
	"operator",
	"backup",
	"restore",
	"version",
];

/** The local PGlite instance commands, run in this process. */
export async function runLocal(args: string[], runtime: LocalRuntime) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			"data-dir": {
				type: "string",
				default:
					process.env.TOOLSTILE_DATA_DIR ??
					join(homedir(), ".local", "share", "toolstile"),
			},
			// Defaults to http://127.0.0.1:<port>, so a chosen port keeps a matching origin.
			origin: { type: "string" },
			listen: { type: "string", default: "127.0.0.1" },
			port: { type: "string", default: "4310" },
		},
	});
	const [command, argument] = positionals;
	const usage = `Usage: ${runtime.name} ${commands.join("|")} [argument] [--data-dir path]`;
	if (!command || !commands.includes(command)) throw new Error(usage);
	if (command === "version") {
		console.log(runtime.version);
		return;
	}
	const directory = resolve(values["data-dir"]);
	const configuration = join(directory, "instance.json");
	if (command === "restore") {
		if (!argument)
			throw new Error(
				`Usage: ${runtime.name} restore /absolute/backup-directory --data-dir /absolute/instance-directory`,
			);
		await restoreInstance(resolve(argument), directory);
		console.log(`restore complete: ${directory}`);
		return;
	}
	if (command === "init" && !existsSync(configuration))
		initialize(directory, configuration, values);
	loadEnvironment(directory, configuration);
	if (command === "init") {
		await migrate(runtime.migrationsFolder());
		console.log(`Instance initialized in ${directory}`);
	} else if (command === "start") {
		await migrate(runtime.migrationsFolder());
		await runtime.startServer();
	} else if (command === "bootstrap" || command === "operator") {
		if (!argument?.includes("@"))
			throw new Error(`Usage: ${runtime.name} ${command} email@example.com`);
		const { pool } = openDatabase(process.env.DATABASE_URL ?? "");
		try {
			if (command === "bootstrap")
				console.log(
					`Invitation (valid 24 hours): ${await inviteUser(pool, argument, process.env.BETTER_AUTH_URL ?? "")}`,
				);
			else {
				await grantOperator(pool, argument);
				console.log("Operator access granted to the selected account");
			}
		} finally {
			await pool.end();
		}
	} else if (command === "backup") {
		if (!argument)
			throw new Error(
				`Usage: ${runtime.name} backup /absolute/backup-directory --data-dir /absolute/instance-directory`,
			);
		await backupInstance(resolve(argument), directory);
		console.log(`backup complete: ${resolve(argument)}`);
	}
}

function initialize(
	directory: string,
	configuration: string,
	values: { origin?: string; listen: string; port: string },
) {
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("Invalid listening port");
	const origin = new URL(values.origin ?? `http://127.0.0.1:${port}`);
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

/** Configure this process for the instance; the server reads it when imported. */
function loadEnvironment(directory: string, configuration: string) {
	if (!existsSync(configuration))
		throw new Error("Initialize the instance first");
	const config = JSON.parse(readFileSync(configuration, "utf8"));
	if (
		config.version !== 1 ||
		!/^[a-f0-9]{64}$/.test(config.authSecret) ||
		!/^[a-f0-9]{64}$/.test(config.encryptionKey)
	)
		throw new Error("Invalid local instance configuration");
	Object.assign(process.env, {
		DATABASE_URL: `pglite:${join(directory, "pglite")}`,
		BETTER_AUTH_URL: config.origin,
		BETTER_AUTH_SECRET: config.authSecret,
		ENCRYPTION_KEY: config.encryptionKey,
		HOST: config.host,
		PORT: String(config.port),
		TOOLSTILE_CATALOG_FETCH: process.env.TOOLSTILE_CATALOG_FETCH ?? "off",
	});
}

async function migrate(migrationsFolder: string) {
	const { pool } = openDatabase(process.env.DATABASE_URL ?? "");
	try {
		await migrateDatabaseWithLock(pool, { migrationsFolder });
		console.log("Migrations applied");
	} finally {
		await pool.end();
	}
}
