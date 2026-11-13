import {
	catalogSettings,
	catalogSourceFor,
	createCatalogFetchPolicy,
} from "@toolstile/api/catalog-source";

// The catalog fetch is public HTTPS only, whatever the instance's private-network setting.
const fetchPolicy = createCatalogFetchPolicy();
/** This process's connector catalog: www.toolstile.com unless TOOLSTILE_CATALOG_FETCH=off. */
export const catalogSource = () =>
	catalogSourceFor({
		...catalogSettings(process.env),
		fetchPolicy,
		// Loaded on first use: the snapshot module is bundled by Vite, not loaded by CLI scripts.
		snapshot: () =>
			import("@toolstile/api/catalog-snapshot").then(
				(module) => module.bundledCatalogSnapshot,
			),
	});
