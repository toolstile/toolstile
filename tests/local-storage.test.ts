import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../packages/database/src/index";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "toolstile-local-lifecycle-"));
	directories.push(root);
	return {
		root,
		data: join(root, "instance"),
		backup: join(root, "backup"),
		restored: join(root, "restored"),
	};
}
const command = (data: string, ...args: string[]) =>
	execute(process.execPath, ["scripts/local.mjs", ...args, "--data-dir", data]);

test("local initialization, migration, backup and restore retain data and stable private keys", async () => {
	const { data, backup, restored } = await fixture();
	await command(data, "init");
	const key = await readFile(join(data, "instance.json"), "utf8");
	await command(data, "init");
	expect(await readFile(join(data, "instance.json"), "utf8")).toBe(key);
	const db = openDatabase(`pglite:${join(data, "pglite")}`);
	try {
		await db.pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
			"survives",
			"Local user",
			"local@test.invalid",
		]);
	} finally {
		await db.pool.end();
	}
	await command(data, "backup", backup);
	await expect(command(data, "backup", backup)).rejects.toThrow();
	await command(restored, "restore", backup);
	await expect(command(restored, "restore", backup)).rejects.toThrow();
	await command(restored, "init");
	expect(await readFile(join(restored, "instance.json"), "utf8")).toBe(key);
	const restoredDb = openDatabase(`pglite:${join(restored, "pglite")}`);
	try {
		expect((await restoredDb.pool.query('SELECT id FROM "user"')).rows).toEqual(
			[{ id: "survives" }],
		);
	} finally {
		await restoredDb.pool.end();
	}
	for (const directory of [data, backup, restored]) {
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		for (const file of ["instance.json"])
			expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
	}
}, 90_000);

test("restore refuses corrupted data and keys without creating an instance", async () => {
	const { data, backup, restored } = await fixture();
	await command(data, "init");
	await command(data, "backup", backup);
	const manifest = JSON.parse(
		await readFile(join(backup, "manifest.json"), "utf8"),
	);
	await writeFile(join(backup, "instance.json"), "{}");
	await expect(command(restored, "restore", backup)).rejects.toThrow();
	await expect(stat(restored)).rejects.toThrow();
	manifest.files["instance.json"] = createHash("sha256")
		.update("{}")
		.digest("hex");
	await writeFile(join(backup, "manifest.json"), JSON.stringify(manifest));
	await expect(command(restored, "restore", backup)).rejects.toThrow();
	await expect(stat(restored)).rejects.toThrow();
}, 90_000);

test("local serving refuses plain HTTP beyond loopback", async () => {
	const { data } = await fixture();
	await expect(
		command(
			data,
			"init",
			"--origin",
			"http://192.168.1.2:4310",
			"--listen",
			"0.0.0.0",
		),
	).rejects.toThrow();
	await expect(stat(data)).rejects.toThrow();
	await expect(command(data, "init", "--listen", "0.0.0.0")).rejects.toThrow();
	await expect(stat(data)).rejects.toThrow();
});
