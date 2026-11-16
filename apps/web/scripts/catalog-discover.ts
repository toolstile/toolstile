import {
	applyInventories,
	discoverAll,
	discoveryPlan,
	inventorySummary,
	readCatalogFile,
	writeCatalogFile,
} from "./catalog-sync";

// vp run catalog:discover [slugs...] [--write]: lists tools into the bundled v1 snapshot's
// `toolSnapshot`. The published catalog on www stays the source; this refreshes the fallback.
const args = process.argv.slice(2);
const write = args.includes("--write");
const slugs = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--write"))
	throw new Error("Usage: catalog:discover [slugs...] [--write]");
const { raw, entries } = await readCatalogFile();
const unknown = slugs.filter(
	(slug) => !entries.some((entry) => entry.slug === slug),
);
if (unknown.length) throw new Error(`Unknown connector: ${unknown.join(", ")}`);
const plans = entries
	.filter((entry) => !slugs.length || slugs.includes(entry.slug))
	.map((entry) => discoveryPlan(entry, process.env));
const runnable = plans.flatMap((plan) => ("headers" in plan ? [plan] : []));
const results = await discoverAll(runnable, {
	timeoutMs: 20_000,
	concurrency: 6,
});
const updates = new Map(
	results.flatMap((result) =>
		"inventory" in result ? [[result.id, result.inventory] as const] : [],
	),
);
for (const result of results)
	console.log(
		"inventory" in result
			? `ok      ${result.id}: ${inventorySummary(
					entries.find((entry) => entry.slug === result.id)?.toolSnapshot,
					result.inventory,
				)}`
			: `failed  ${result.id}: ${result.error}`,
	);
if (slugs.length)
	for (const plan of plans)
		if ("skip" in plan) console.log(`skipped ${plan.entry.slug}: ${plan.skip}`);
console.log(
	`${updates.size} discovered, ${results.length - updates.size} failed, ${plans.length - runnable.length} skipped (sign-in or configuration required).`,
);
if (write && updates.size) {
	await writeCatalogFile(applyInventories(raw, updates));
	console.log("Wrote packages/api/catalog/v1.json.");
} else if (!write) console.log("Preview only. Run with --write to save.");
