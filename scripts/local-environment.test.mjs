import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import { test } from "vitest";
import {
	assertTestOwnership,
	isolatedWorktreeEnvironment,
	localTestEnvironment,
	serializeEnvironment,
} from "./local-environment.mjs";

const base = {
	DATABASE_URL: "postgresql://user:sentinel@localhost:5432/toolstile",
	BETTER_AUTH_URL: "http://app.localhost:4310",
	BETTER_AUTH_SECRET: "local-secret",
	EXTRA_ORIGIN: "http://mcp.localhost:4310",
};
test("worktree allowlist drops unknown provider sentinels and stale tests, sets the task origin", () => {
	const env = isolatedWorktreeEnvironment(
		{
			...base,
			TEST_DATABASE_URL: "remote",
			TEST_EXTRA_ORIGIN: "remote",
			SMTP_PASSWORD: "sentinel",
			UNKNOWN_PROVIDER_TOKEN: "sentinel",
			REDIS_URL: "sentinel",
		},
		{
			name: "branch",
			database: base.DATABASE_URL.replace("/toolstile", "/toolstile_wt_branch"),
			origin: "http://branch.app.localhost:4310",
		},
	);
	assert.equal(env.BETTER_AUTH_URL, "http://branch.app.localhost:4310");
	assert.equal(env.EXTRA_ORIGIN, undefined);
	for (const key of [
		"TEST_DATABASE_URL",
		"TEST_EXTRA_ORIGIN",
		"SMTP_PASSWORD",
		"UNKNOWN_PROVIDER_TOKEN",
		"REDIS_URL",
	])
		assert.equal(env[key], undefined);
	assert.deepEqual({ ...parseEnv(serializeEnvironment(env)) }, env);
});
test("remote inherited targets and mismatched file overrides fail before execution", () => {
	for (const key of [
		"DATABASE_URL",
		"BETTER_AUTH_URL",
		"EXTRA_ORIGIN",
		"TEST_DATABASE_URL",
		"TEST_BASE_URL",
		"TEST_EXTRA_ORIGIN",
	])
		assert.throws(() =>
			localTestEnvironment(
				base,
				{ [key]: "https://remote.invalid/sentinel" },
				{ originTargets: { EXTRA_ORIGIN: "TEST_EXTRA_ORIGIN" } },
			),
		);
	assert.throws(() =>
		localTestEnvironment({
			...base,
			TEST_BASE_URL: "http://other.localhost:4310",
		}),
	);
	assert.throws(() =>
		localTestEnvironment({
			...base,
			DATABASE_URL: "postgresql://localhost/production",
		}),
	);
	assert.throws(() =>
		localTestEnvironment({
			...base,
			DATABASE_URL: "postgresql://remote.invalid/toolstile",
		}),
	);
	assert.throws(() =>
		localTestEnvironment({
			...base,
			DATABASE_URL: `${base.DATABASE_URL}?host=remote.invalid`,
		}),
	);
});
test("local containers and *.localhost origins accepted; stale unrelated TEST variables cleared", () => {
	const env = localTestEnvironment(
		{
			...base,
			DATABASE_URL: "postgresql://postgres/toolstile",
			UNKNOWN_PROVIDER_TOKEN: "sentinel",
			TEST_UNUSED: "sentinel",
		},
		{ UNKNOWN_PROVIDER_TOKEN: "sentinel", TEST_UNUSED: "sentinel" },
		{ originTargets: { EXTRA_ORIGIN: "TEST_EXTRA_ORIGIN" } },
	);
	assert.equal(env.TEST_UNUSED, undefined);
	assert.equal(env.UNKNOWN_PROVIDER_TOKEN, undefined);
	assert.equal(env.TEST_EXTRA_ORIGIN, base.EXTRA_ORIGIN);
});
test("worktree DB, origin, record generation and server must match", () => {
	const file = {
		...base,
		DATABASE_URL: "postgresql://localhost/toolstile_wt_branch",
		BETTER_AUTH_URL: "http://branch.app.localhost:4310",
		EXTRA_ORIGIN: "http://branch.mcp.localhost:4310",
	};
	const record = {
		version: 1,
		id: "generation",
		setupComplete: true,
		worktree: "/branch",
		main: "/main",
		name: "branch",
		database: "toolstile_wt_branch",
		server: { host: "localhost", port: "5432" },
	};
	const ctx = {
		root: "/branch",
		main: "/main",
		name: "branch",
		file,
		originKeys: ["EXTRA_ORIGIN"],
	};
	assertTestOwnership(record, ctx);
	for (const change of [
		{ worktree: "/other" },
		{ database: "other" },
		{ setupComplete: false },
		{ server: { host: "other", port: "5432" } },
	])
		assert.throws(() => assertTestOwnership({ ...record, ...change }, ctx));
	assert.throws(() =>
		assertTestOwnership(record, {
			...ctx,
			file: { ...file, EXTRA_ORIGIN: base.EXTRA_ORIGIN },
		}),
	);
});
