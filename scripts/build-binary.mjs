import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { constants, createBrotliCompress } from "node:zlib";
import { build } from "esbuild";

// Builds dist/toolstile-server-<os>-<arch>: the local PGlite instance commands, the
// production server and PGlite's WASM in one Node.js single executable application.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
	options: {
		version: { type: "string", default: process.env.TOOLSTILE_VERSION },
		// Also write <executable>.br, the compressed file a release publishes.
		compress: { type: "boolean", default: false },
	},
});
const major = Number(process.versions.node.split(".")[0]);
if (major < 26)
	throw new Error(
		`Building the executable needs Node.js 26 or later (running ${process.version})`,
	);
const version = values.version ?? gitVersion();
const target = `toolstile-server-${process.platform}-${process.arch}`;
const out = join(root, "dist");
const work = join(out, "binary");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

execFileSync("vp", ["run", "build"], {
	cwd: root,
	stdio: "inherit",
	env: { ...process.env, TOOLSTILE_INLINE_ASSETS: "1" },
});
const server = join(root, "apps/web/.output/server/index.mjs");
// Each public asset entry carries its bytes as base64 `data` only in an inline build.
const output = readFileSync(server, "utf8");
const publicAssets = output.match(/"path": "\.\.\/public\//g)?.length ?? 0;
if (!publicAssets || output.match(/"data": "/g)?.length !== publicAssets)
	throw new Error(
		"The server output serves assets from disk; build it with TOOLSTILE_INLINE_ASSETS=1",
	);

const bundle = join(work, "main.mjs");
await build({
	entryPoints: [join(root, "scripts/local-binary.ts")],
	outfile: bundle,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node26",
	minifySyntax: true,
	legalComments: "none",
	logLevel: "warning",
	define: { TOOLSTILE_VERSION: JSON.stringify(version) },
	// Bundled CommonJS dependencies still call require for Node.js built-ins.
	banner: {
		js: 'import { createRequire as __toolstileRequire } from "node:module"; const require = __toolstileRequire(import.meta.url);',
	},
	// pg loads its optional native binding only when asked to; it is never installed.
	external: ["pg-native"],
	plugins: [
		{
			name: "toolstile-server",
			setup(context) {
				context.onResolve({ filter: /^toolstile:server$/ }, () => ({
					path: server,
				}));
			},
		},
		{
			// Nitro keeps CommonJS requires of external packages (react, from a shim) as
			// calls through createRequire, which esbuild cannot follow. As plain requires
			// they are bundled; otherwise the executable would look for node_modules on disk.
			name: "nitro-requires",
			setup(context) {
				const output = join(root, "apps/web/.output/server");
				context.onLoad({ filter: /\.mjs$/ }, (file) => {
					if (!file.path.startsWith(output)) return undefined;
					const contents = readFileSync(file.path, "utf8").replace(
						/\b__require\("([^"]+)"\)/g,
						(call, id) =>
							isBuiltin(id) ? call : `require(${JSON.stringify(id)})`,
					);
					return { contents, loader: "js", resolveDir: dirname(file.path) };
				});
			},
		},
	],
});

const pglite = dirname(
	createRequire(join(root, "packages/database/package.json")).resolve(
		"@electric-sql/pglite",
	),
);
const assets = {
	"pglite.wasm": join(pglite, "pglite.wasm"),
	"initdb.wasm": join(pglite, "initdb.wasm"),
	"pglite.data": join(pglite, "pglite.data"),
};
const migrations = join(root, "apps/web/postgres-migrations");
for (const file of readdirSync(migrations, {
	recursive: true,
	withFileTypes: true,
}))
	if (file.isFile()) {
		const path = join(file.parentPath, file.name);
		assets[`migrations/${relative(migrations, path)}`] = path;
	}

const executable = join(out, target);
rmSync(executable, { force: true });
rmSync(`${executable}.br`, { force: true });
const config = join(work, "sea-config.json");
writeFileSync(
	config,
	JSON.stringify({
		main: bundle,
		mainFormat: "module",
		output: executable,
		disableExperimentalSEAWarning: true,
		assets,
	}),
);
execFileSync(process.execPath, ["--build-sea", config], { stdio: "inherit" });
// Injection invalidates the Node.js signature, and macOS runs no unsigned arm64 code.
if (process.platform === "darwin")
	execFileSync("codesign", ["--sign", "-", "--force", executable], {
		stdio: "inherit",
	});
const digest = createHash("sha256")
	.update(readFileSync(executable))
	.digest("hex");
writeFileSync(`${executable}.sha256`, `${digest}  ${target}\n`);
if (values.compress) {
	const { BROTLI_PARAM_LGWIN, BROTLI_PARAM_QUALITY, BROTLI_PARAM_SIZE_HINT } =
		constants;
	const size = statSync(executable).size;
	await pipeline(
		createReadStream(executable),
		createBrotliCompress({
			params: {
				[BROTLI_PARAM_QUALITY]: 9,
				[BROTLI_PARAM_LGWIN]: 24,
				[BROTLI_PARAM_SIZE_HINT]: size,
			},
		}),
		createWriteStream(`${executable}.br`),
	);
}
console.log(`Built ${relative(root, executable)} (${version})`);

function gitVersion() {
	try {
		return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
	} catch {
		return "dev";
	}
}
