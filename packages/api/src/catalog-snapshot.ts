import catalog from "../catalog/v1.json" with { type: "json" };
import type { CatalogSnapshot } from "./catalog-source.js";

// Bundled into the server build, so the snapshot never depends on files next to the output.
// SVG is embedded as exact text; raster files as base64 data URIs. The source verifies every
// file against its SHA-256 before serving it. Import this module only from Vite-built code.
const svg = import.meta.glob<string>("../catalog/logos/*.svg", {
	query: "?raw",
	import: "default",
	eager: true,
});
const raster = import.meta.glob<string>("../catalog/logos/*.{png,webp}", {
	query: "?inline",
	import: "default",
	eager: true,
});

/** The committed v1 catalog (`catalog:snapshot`/`catalog:pull`) and its logo files. */
export const bundledCatalogSnapshot: CatalogSnapshot = {
	catalog,
	logo(sha256, type) {
		const path = `../catalog/logos/${sha256}.${type}`;
		if (type === "svg") {
			const text = svg[path];
			return text === undefined ? undefined : Buffer.from(text, "utf8");
		}
		const data = /^data:[^,;]+;base64,(.*)$/s.exec(raster[path] ?? "");
		return data ? Buffer.from(data[1], "base64") : undefined;
	},
};
