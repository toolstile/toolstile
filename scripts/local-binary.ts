import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAsset, getAssetKeys } from "node:sea";
import { providePGliteArtifacts } from "../packages/database/src/pglite";
import { runLocal } from "./local-commands";

// Replaced at build time with the release version.
declare const TOOLSTILE_VERSION: string;

const migrations = "migrations/";
const args = process.argv.slice(2);

try {
	if (args[0] !== "version")
		providePGliteArtifacts({
			pgliteWasmModule: await WebAssembly.compile(getAsset("pglite.wasm")),
			initdbWasmModule: await WebAssembly.compile(getAsset("initdb.wasm")),
			fsBundle: new Blob([getAsset("pglite.data")]),
		});
	await runLocal(args, {
		name: "toolstile-server",
		version: TOOLSTILE_VERSION,
		migrationsFolder() {
			// The migrator reads a folder, so write this release's journal to a private
			// temporary one for the life of the process.
			const folder = mkdtempSync(join(tmpdir(), "toolstile-migrations-"));
			process.once("exit", () =>
				rmSync(folder, { recursive: true, force: true }),
			);
			for (const key of getAssetKeys())
				if (key.startsWith(migrations)) {
					const file = join(folder, key.slice(migrations.length));
					mkdirSync(dirname(file), { recursive: true });
					writeFileSync(file, new Uint8Array(getAsset(key)));
				}
			return folder;
		},
		// scripts/build-binary.mjs resolves this to the built Nitro server.
		startServer: () => import("toolstile:server"),
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
