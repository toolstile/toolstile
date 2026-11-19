import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

// Runs the local instance commands from a source checkout. The single executable
// (scripts/build-binary.mjs) runs the same commands with its embedded files.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "apps/web/.output/server/index.mjs");
register();
const { runLocal } = await import("./local-commands.ts");
if (process.argv[2] === "start" && !existsSync(server))
	throw new Error("Build first with vp run build");
await runLocal(process.argv.slice(2), {
	name: "node scripts/local.mjs",
	version: "source checkout",
	migrationsFolder: () => join(root, "apps/web/postgres-migrations"),
	startServer: () => import(pathToFileURL(server).href),
});
