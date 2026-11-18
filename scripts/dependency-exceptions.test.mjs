import assert from "node:assert/strict";
import { test } from "vitest";
import { unacceptedAdvisories } from "./dependency-exceptions.mjs";

const now = new Date("2026-11-18T00:00:00Z");
const exception = {
	advisory: "GHSA-aaaa-bbbb-cccc",
	package: "globber",
	version: "1.0.0",
	pathSuffix: [">build-tool>globber", ">test-runner>globber"],
	expires: "2026-12-15",
	reason: "Reached only through build tooling.",
};
const advisory = (overrides = {}) => ({
	github_advisory_id: "GHSA-aaaa-bbbb-cccc",
	module_name: "globber",
	findings: [
		{
			version: "1.0.0",
			paths: [
				"apps__web>framework>build-tool>globber",
				"apps__web>test-runner>globber",
			],
		},
	],
	...overrides,
});
const unaccepted = (advisories, exceptions = [exception], at = now) =>
	unacceptedAdvisories({ 1: advisories }, exceptions, at).length;

test("an exception accepts its advisory only on the listed parents and version", () => {
	assert.equal(unaccepted(advisory()), 0);
	assert.equal(unaccepted(advisory(), []), 1);
	assert.equal(
		unaccepted(advisory({ github_advisory_id: "GHSA-dddd-eeee-ffff" })),
		1,
	);
	assert.equal(unaccepted(advisory({ module_name: "other" })), 1);
	assert.equal(
		unaccepted(
			advisory({
				findings: [{ version: "1.0.1", paths: ["a>build-tool>globber"] }],
			}),
		),
		1,
	);
	assert.equal(
		unaccepted(
			advisory({
				findings: [
					{ version: "1.0.0", paths: ["apps__web>server-lib>globber"] },
				],
			}),
		),
		1,
	);
	assert.equal(unaccepted(advisory({ findings: [] })), 1);
	assert.equal(
		unaccepted(advisory({ findings: [{ version: "1.0.0", paths: [] }] })),
		1,
	);
	assert.equal(unaccepted(advisory(), [{ ...exception, pathSuffix: "" }]), 1);
	assert.equal(
		unaccepted(advisory(), [
			{ ...exception, pathSuffix: ">build-tool>globber" },
		]),
		1,
	);
});

test("an expired or unexplained exception fails the audit", () => {
	assert.throws(() =>
		unaccepted(advisory(), [exception], new Date("2026-12-15T00:00:00Z")),
	);
	assert.throws(() => unaccepted(advisory(), [{ ...exception, reason: "" }]));
	assert.throws(() =>
		unaccepted(advisory(), [{ ...exception, expires: "soon" }]),
	);
});
