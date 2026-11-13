import { defineConfig } from "vitest/config";
import SkipSummaryReporter from "./scripts/vitest-skip-summary.mjs";

export default defineConfig({
	test: {
		// Direct runs end with a loud summary when fixture-dependent suites skipped.
		reporters: ["default", new SkipSummaryReporter()],
		// Tests never fetch the live connector catalog; catalog-source tests use stub fetchers.
		env: { TOOLSTILE_CATALOG_FETCH: "off" },
		// Files run in parallel: each integration file creates its own database
		// and isolation keeps environment-bound runtime imports per file.
		maxWorkers: 4,
		// Isolated storage/emulator fixture setup is bounded under parallel load.
		hookTimeout: 60_000,
		// Embedded PGlite starts several times slower on small CI runners than locally.
		testTimeout: 30_000,
	},
});
