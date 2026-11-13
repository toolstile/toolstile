import {
	catalogSettings,
	createCatalogFetchPolicy,
	pullCatalog,
} from "@toolstile/api/catalog-source";
import { writeCatalogSnapshot } from "./catalog-v1";

// pnpm catalog:pull [url] [--write]: replaces the bundled snapshot with a published v1 catalog,
// fetched through the same public-HTTPS egress policy the running source uses.
const args = process.argv.slice(2);
const urls = args.filter((arg) => !arg.startsWith("--"));
if (
	args.some((arg) => arg.startsWith("--") && arg !== "--write") ||
	urls.length > 1
)
	throw new Error("Usage: catalog:pull [url] [--write]");
const url = urls[0] ?? catalogSettings(process.env).url;
const { document, logos, dropped, problems } = await pullCatalog({
	url,
	fetchPolicy: createCatalogFetchPolicy(),
});
for (const problem of problems) console.log(`logo    ${problem}`);
console.log(
	`${document.entries.length} listed entries, ${logos.size} logos, ${dropped} invalid entries skipped from ${url}.`,
);
if (args.includes("--write")) {
	await writeCatalogSnapshot(document, logos);
	console.log("Wrote packages/api/catalog/v1.json and logos.");
} else console.log("Preview only. Run with --write to save.");
