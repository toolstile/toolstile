import stylex from "@stylexjs/unplugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import { stylexSources } from "./stylex-warmup";

for (const [key, value] of Object.entries(
	loadEnv("development", process.cwd(), ""),
))
	process.env[key] ??= value;
const stylexOptions = {
	useCSSLayers: { before: ["legacy"], prefix: "stylex" },
	externalPackages: ["@toolstile/ui"],
	devPersistToDisk: true,
	unstable_moduleResolution: { type: "commonJS" as const },
};
export default defineConfig({
	plugins: [
		stylex.vite(stylexOptions),
		tanstackStart(),
		nitro({
			preset: "node-server",
			plugins: ["./server/plugins/host.ts", "./server/plugins/lifecycle.ts"],
			traceDeps: ["@electric-sql/pglite*", "react*", "react-dom*"],
			// The single executable has no public folder beside it, so its build embeds
			// the static assets in the server bundle.
			...(process.env.TOOLSTILE_INLINE_ASSETS === "1" && {
				serveStatic: "inline" as const,
			}),
		}),
		react(),
	],
	// PGlite resolves its WASM and data files relative to its package entry.
	// Keep the package external and trace its complete runtime assets into output.
	ssr: { external: ["@electric-sql/pglite", "react", "react-dom"] },
	server: {
		port: Number(process.env.PORT) || 4310,
		host: process.env.HOST || "127.0.0.1",
		// Compile every StyleX rule at startup, so a page is styled on its first visit.
		warmup: {
			clientFiles: stylexSources(
				["./src", "../../packages/ui/src"].map((path) =>
					fileURLToPath(new URL(path, import.meta.url)),
				),
			),
		},
	},
	// A budget, not a silenced warning: the shared UI chunk is about 674 kB,
	// mostly Base UI, zod (search validation) and icons, so it flags growth only.
	build: { chunkSizeWarningLimit: 710 },
});
