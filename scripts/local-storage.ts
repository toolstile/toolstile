import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../packages/database/src/index";
import { ownedPGlite } from "../packages/database/src/pglite";

const [command, backupDirectory, dataDirectory] = process.argv.slice(2);
if (
	!backupDirectory ||
	!dataDirectory ||
	!["backup", "restore"].includes(command)
)
	throw new Error("Invalid storage operation");
const hash = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
const files = ["pgdata.tar", "instance.json"];
if (command === "backup") {
	if (
		!existsSync(join(dataDirectory, "pglite")) ||
		!existsSync(join(dataDirectory, "instance.json"))
	)
		throw new Error("Missing initialized instance");
	const database = openDatabase(`pglite:${join(dataDirectory, "pglite")}`);
	try {
		const archive = await database.storage.backup?.();
		if (!archive) throw new Error("PGlite backup unavailable");
		mkdirSync(backupDirectory, { mode: 0o700 });
		try {
			writeFileSync(
				join(backupDirectory, "pgdata.tar"),
				Buffer.from(await archive.arrayBuffer()),
				{ flag: "wx", mode: 0o600 },
			);
			copyFileSync(
				join(dataDirectory, "instance.json"),
				join(backupDirectory, "instance.json"),
			);
			chmodSync(join(backupDirectory, "instance.json"), 0o600);
			writeFileSync(
				join(backupDirectory, "manifest.json"),
				JSON.stringify({
					version: 2,
					files: Object.fromEntries(
						files.map((file) => [file, hash(join(backupDirectory, file))]),
					),
				}),
				{ flag: "wx", mode: 0o600 },
			);
		} catch (error) {
			rmSync(backupDirectory, { recursive: true, force: true });
			throw error;
		}
	} finally {
		await database.pool.end();
	}
} else {
	const manifest = JSON.parse(
		readFileSync(join(backupDirectory, "manifest.json"), "utf8"),
	);
	if (manifest.version !== 2) throw new Error("Unsupported backup version");
	for (const file of files)
		if (manifest.files?.[file] !== hash(join(backupDirectory, file)))
			throw new Error(`Backup checksum mismatch: ${file}`);
	const config = JSON.parse(
		readFileSync(join(backupDirectory, "instance.json"), "utf8"),
	);
	if (
		config.version !== 1 ||
		!/^[a-f0-9]{64}$/.test(config.authSecret) ||
		!/^[a-f0-9]{64}$/.test(config.encryptionKey)
	)
		throw new Error("Invalid backup configuration");
	mkdirSync(dataDirectory, { mode: 0o700 });
	try {
		const owned = ownedPGlite(join(dataDirectory, "pglite"), {
			loadDataDir: new Blob([
				readFileSync(join(backupDirectory, "pgdata.tar")),
			]),
		});
		try {
			await owned.database.waitReady;
			await owned.database.query("SELECT 1");
		} finally {
			await owned.database.close();
			owned.release();
		}
		copyFileSync(
			join(backupDirectory, "instance.json"),
			join(dataDirectory, "instance.json"),
		);
		chmodSync(join(dataDirectory, "instance.json"), 0o600);
	} catch (error) {
		rmSync(dataDirectory, { recursive: true, force: true });
		throw error;
	}
}
console.log(
	`${command} complete: ${command === "backup" ? backupDirectory : dataDirectory}`,
);
