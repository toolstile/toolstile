// Ends every direct Vitest run with a loud summary when suites were skipped,
// so a bare `pnpm test` is never mistaken for complete acceptance.
const FIXTURE_VARIABLES = [
	"TEST_DATABASE_URL",
	"TEST_BASE_URL",
	"DATABASE_URL",
];

export function skipSummary(testModules, env = process.env, command) {
	let skippedFiles = 0;
	let skippedTests = 0;
	let totalTests = 0;
	for (const module of testModules) {
		let skippedHere = 0;
		let testsHere = 0;
		for (const test of module.children.allTests()) {
			testsHere++;
			if (test.result().state === "skipped") skippedHere++;
		}
		totalTests += testsHere;
		skippedTests += skippedHere;
		if (
			module.state() === "skipped" ||
			(testsHere > 0 && skippedHere === testsHere)
		)
			skippedFiles++;
	}
	if (!skippedTests && !skippedFiles) return undefined;
	const missing = FIXTURE_VARIABLES.filter((name) => !env[name]);
	const cause = missing.length
		? `${missing.join(", ")} not set, so database/HTTP suites skipped themselves`
		: "suites or tests were explicitly skipped";
	return [
		"",
		`INCOMPLETE: ${skippedFiles} of ${testModules.length} test files and ${skippedTests} of ${totalTests} tests were SKIPPED (${cause}).`,
		"This run is not a full pass. Run the complete suite with its own disposable database and server:",
		`  ${command}`,
		"",
	].join("\n");
}

export default class SkipSummaryReporter {
	constructor({ command = "pnpm build && pnpm test:local" } = {}) {
		this.command = command;
	}
	onTestRunEnd(testModules) {
		const summary = skipSummary(testModules, process.env, this.command);
		if (summary) process.stderr.write(`\x1b[1;33m${summary}\x1b[0m\n`);
	}
}
