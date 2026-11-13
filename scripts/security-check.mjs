import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

// Deliberately narrow exception: optional legacy Drizzle Kit loader only. This
// advisory concerns esbuild's serve API; migrations do not start that server.
const exception = {
	id: "GHSA-67mh-4wv8-2f99",
	package: "esbuild",
	version: "0.18.20",
	expires: "2026-12-01T00:00:00Z",
};
let failed = false;
const audit = spawnSync("pnpm", ["audit", "--prod", "--json"], {
	encoding: "utf8",
	maxBuffer: 16 * 1024 * 1024,
	timeout: 120_000,
});
try {
	const report = JSON.parse(audit.stdout);
	if (
		audit.error ||
		(audit.status !== 0 && audit.status !== 1) ||
		report.error ||
		!report.advisories ||
		typeof report.advisories !== "object" ||
		!report.metadata?.vulnerabilities ||
		Object.values(report.metadata.vulnerabilities).some(
			(count) =>
				typeof count !== "number" || !Number.isFinite(count) || count < 0,
		) ||
		(Object.values(report.metadata.vulnerabilities).some(
			(count) => count > 0,
		) &&
			!Object.keys(report.advisories).length)
	)
		throw new Error("Unavailable advisory report");
	for (const advisory of Object.values(report.advisories)) {
		const exempt =
			advisory.github_advisory_id === exception.id &&
			advisory.module_name === exception.package &&
			Date.now() < Date.parse(exception.expires) &&
			advisory.findings?.length > 0 &&
			advisory.findings.every(
				(finding) =>
					finding.optional === true &&
					finding.version === exception.version &&
					finding.paths?.length > 0 &&
					finding.paths.every(
						(path) =>
							path.includes("drizzle-kit") &&
							path.includes("@esbuild-kit/core-utils"),
					),
			);
		if (!exempt) {
			console.error(
				"Unaccepted dependency advisory; inspect the registry report privately",
			);
			failed = true;
		}
	}
	if (audit.status !== 0 && !Object.keys(report.advisories).length)
		throw new Error("Audit failed");
} catch {
	console.error("Dependency audit failed to return a usable report");
	failed = true;
}

// Scan tracked text only; never print matched values or source lines. This is
// a targeted credential guard, not a historical or entropy-based secret audit.
const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (tracked.status !== 0) {
	console.error("Cannot enumerate tracked files for secret checks");
	failed = true;
} else {
	const patterns = [
		["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
		[
			"github-token",
			/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/,
		],
		["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
		["stripe-live-key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
	];
	for (const file of tracked.stdout.split("\0").filter(Boolean)) {
		if (
			/(^|\/)(?:node_modules|dist|build|coverage|output|migrations|\.git|\.output|\.tanstack)(\/|$)/.test(
				file,
			) ||
			/(?:\.gen\.|pnpm-lock\.yaml$|catalog\/)/.test(file)
		)
			continue;
		let bytes;
		try {
			if (lstatSync(file).isSymbolicLink()) continue;
			bytes = readFileSync(file);
		} catch {
			failed = true;
			console.error("Cannot read tracked file");
			continue;
		}
		if (bytes.includes(0)) continue;
		const content = bytes.toString("utf8");
		for (const [rule, pattern] of patterns)
			if (pattern.test(content)) {
				console.error(
					`Secret pattern ${rule} in ${JSON.stringify(file)} [REDACTED]`,
				);
				failed = true;
			}
	}
}
process.exitCode = failed ? 1 : 0;
