import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
/** PGlite has one process owner. A second process must never open its data files. */
export function ownedPGlite(directory: string, options: PGliteOptions = {}) {
	if (directory === ":memory:")
		return { database: new PGlite("memory://", options), release: () => {} };
	const path = resolve(directory);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.owner`;
	// Serialize stale-owner recovery too: two starters must never both replace it.
	const startup = `${path}.startup`;
	try {
		writeFileSync(startup, String(process.pid), { flag: "wx", mode: 0o600 });
	} catch {
		throw new Error(
			"PGlite ownership inspection is already running; retry after it completes. A leftover startup marker needs operator inspection.",
		);
	}
	try {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
		} catch (error) {
			if (
				!(
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "EEXIST"
				)
			)
				throw error;
			const pid = Number(readFileSync(lock, "utf8"));
			let running = true;
			try {
				process.kill(pid, 0);
			} catch (e) {
				if (e && typeof e === "object" && "code" in e && e.code === "ESRCH")
					running = false;
			}
			if (running || !Number.isSafeInteger(pid) || pid < 1)
				throw new Error(
					"PGlite data directory is already owned; stop the instance before backup or maintenance",
				);
			unlinkSync(lock);
			writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
		}
	} finally {
		unlinkSync(startup);
	}
	try {
		return {
			database: new PGlite(path, options),
			release: () => {
				if (readFileSync(lock, "utf8") === String(process.pid))
					unlinkSync(lock);
			},
		};
	} catch (error) {
		unlinkSync(lock);
		throw error;
	}
}
