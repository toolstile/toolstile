import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

const valid = {
	DATABASE_URL: "/tmp/toolstile-test-pglite",
	BETTER_AUTH_URL: "http://127.0.0.1:4310",
	BETTER_AUTH_SECRET: "a1".repeat(32),
	ENCRYPTION_KEY: "b2".repeat(32),
};
async function load(values: Record<string, string>) {
	for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
	vi.resetModules();
	return import("../apps/web/src/server/env");
}
afterEach(() => {
	vi.unstubAllEnvs();
});

it("accepts generated values", async () => {
	await expect(load(valid)).resolves.toMatchObject({
		env: { BETTER_AUTH_URL: "http://127.0.0.1:4310" },
	});
});

it.each([["apps/web/.env.example"], [".env.example"]])(
	"refuses the unedited placeholders in %s without echoing them",
	async (file) => {
		const example = parseEnv(readFileSync(file, "utf8"));
		const error = await load({
			...valid,
			...Object.fromEntries(
				[
					"DATABASE_URL",
					"BETTER_AUTH_URL",
					"BETTER_AUTH_SECRET",
					"ENCRYPTION_KEY",
				].map((key) => [key, String(example[key])]),
			),
		}).then(
			() => undefined,
			(reason: Error) => reason,
		);
		expect(error?.message).toContain("Invalid server configuration");
		for (const key of ["DATABASE_URL", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY"])
			expect(error?.message).toContain(`- ${key}:`);
		expect(error?.message).not.toContain(String(example.BETTER_AUTH_SECRET));
	},
);

it("turns local commands on only by name and only in local mode", async () => {
	await expect(load(valid)).resolves.toMatchObject({
		env: { localCommands: false },
	});
	await expect(
		load({ ...valid, TOOLSTILE_STDIO: " On " }),
	).resolves.toMatchObject({ env: { localCommands: true } });
	await expect(load({ ...valid, TOOLSTILE_STDIO: "yes" })).rejects.toThrow(
		"- TOOLSTILE_STDIO: TOOLSTILE_STDIO must be on or off",
	);
	// A PostgreSQL server (containers and Kubernetes) refuses to start with it on.
	const postgres = {
		...valid,
		DATABASE_URL: "postgresql://toolstile@127.0.0.1/toolstile",
	};
	await expect(load({ ...postgres, TOOLSTILE_STDIO: "on" })).rejects.toThrow(
		"TOOLSTILE_STDIO=on is supported only in local mode",
	);
	await expect(
		load({ ...postgres, TOOLSTILE_STDIO: "off" }),
	).resolves.toMatchObject({ env: { localCommands: false } });
});
