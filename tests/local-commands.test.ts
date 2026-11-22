import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createClient } from "@toolstile/api/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../packages/auth/src/index";
import {
	authSchema,
	migrateDatabase,
	openDatabase,
} from "../packages/database/src/index";

const script = resolve("tests/fixtures/stdio-server.mjs");
const password = "Local-command-test-password-12345";

async function freePort() {
	const reservation = createServer();
	await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
	const address = reservation.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	await new Promise<void>((done, reject) =>
		reservation.close((error) => (error ? reject(error) : done())),
	);
	return address.port;
}
async function stop(server: ChildProcess) {
	if (server.exitCode !== null) return;
	const exited = new Promise<void>((done) => server.once("exit", () => done()));
	server.kill("SIGTERM");
	const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
	try {
		await exited;
	} finally {
		clearTimeout(force);
	}
}

/** The production server on a PGlite directory (local mode), as `toolstile-server start` runs it. */
describe("local commands in local mode", () => {
	let directory = "";
	let server: ChildProcess | undefined;
	let origin = "";
	let databaseUrl = "";
	const secret = randomBytes(32).toString("hex"),
		encryptionKey = randomBytes(32).toString("hex");
	const cookies: Record<"operator" | "member", string> = {
		operator: "",
		member: "",
	};

	async function start(stdio: "on" | "off") {
		let errors = "";
		const port = await freePort();
		origin = `http://127.0.0.1:${port}`;
		server = spawn(
			process.execPath,
			[resolve("apps/web/.output/server/index.mjs")],
			{
				cwd: directory,
				env: {
					...process.env,
					DATABASE_URL: databaseUrl,
					BETTER_AUTH_URL: origin,
					BETTER_AUTH_SECRET: secret,
					ENCRYPTION_KEY: encryptionKey,
					HOST: "127.0.0.1",
					PORT: String(port),
					TOOLSTILE_CATALOG_FETCH: "off",
					TOOLSTILE_STDIO: stdio,
					NODE_ENV: "production",
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		server.stderr?.on("data", (chunk) => {
			errors += String(chunk);
		});
		const deadline = Date.now() + 15_000;
		for (;;) {
			if (server.exitCode !== null)
				throw new Error(`Server exited before readiness: ${errors}`);
			if (
				await fetch(`${origin}/health`).then(
					(response) => response.ok,
					() => false,
				)
			)
				break;
			if (Date.now() > deadline)
				throw new Error(`Server did not become healthy: ${errors}`);
			await new Promise((done) => setTimeout(done, 50));
		}
		for (const who of ["operator", "member"] as const) {
			const response = await fetch(`${origin}/api/auth/sign-in/email`, {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body: JSON.stringify({ email: `${who}@test.invalid`, password }),
			});
			expect(response.status).toBe(200);
			cookies[who] = response.headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; ");
		}
	}
	async function restart(stdio: "on" | "off") {
		if (server) await stop(server);
		await start(stdio);
	}
	const api = (who: "operator" | "member") =>
		createClient(`${origin}/api/rpc`, () => ({
			cookie: cookies[who],
			origin,
		}));
	/** The instance's own procedure, outside the shared management client. */
	async function addLocalCommand(
		who: "operator" | "member",
		input: Record<string, unknown>,
	) {
		const response = await fetch(`${origin}/api/rpc/addLocalCommand`, {
			method: "POST",
			headers: {
				cookie: cookies[who],
				origin,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ json: input }),
		});
		const body = (await response.json()) as {
			json: { id: string; label: string; message?: string };
		};
		return { status: response.status, body: body.json };
	}

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "toolstile-local-commands-"));
		databaseUrl = `pglite:${join(directory, "database")}`;
		const database = openDatabase(databaseUrl);
		try {
			await migrateDatabase(database.db, {
				migrationsFolder: "apps/web/postgres-migrations",
			});
			const auth = createAuth({
				database: database.db,
				schema: authSchema,
				baseURL: "http://127.0.0.1",
				secret,
				canRegister: async () => true,
			});
			for (const who of ["operator", "member"])
				await auth.api.signUpEmail({
					body: { name: who, email: `${who}@test.invalid`, password },
				});
			await database.pool.query(
				`insert into profiles("userId",operator) select id, email='operator@test.invalid' from "user"`,
			);
		} finally {
			await database.pool.end();
		}
		await start("on");
	}, 60_000);
	afterAll(async () => {
		if (server) await stop(server);
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("lets only operators add a command, and never starts one for anyone else", async () => {
		const marker = join(directory, "member-ran");
		const refused = await addLocalCommand("member", {
			command: process.execPath,
			args: [
				"-e",
				`require("fs").writeFileSync(${JSON.stringify(marker)},"x")`,
			],
		});
		expect(refused.status).toBe(403);
		expect(refused.body.message).toBe(
			"Only instance operators can add and run local commands",
		);
		expect(existsSync(marker)).toBe(false);
		expect((await api("member").snapshot()).localCommands).toBe(false);
		expect((await api("operator").snapshot()).localCommands).toBe(true);
	});

	it("saves a command an operator adds, showing only its variable names", async () => {
		const failed = await addLocalCommand("operator", {
			command: process.execPath,
			args: [script, "--fail"],
			env: { FIXTURE_TOKEN: "x7q" },
		});
		expect(failed.status).toBe(502);
		expect(failed.body.message).toBe(
			"Toolstile couldn't start this command: the command exited before answering (exit code 3)",
		);

		const added = await addLocalCommand("operator", {
			command: process.execPath,
			args: [script],
			env: { FIXTURE_TOKEN: "stored-secret-value" },
		});
		expect(added.status).toBe(200);
		expect(added.body.label).toBe("stdio-server");
		const snapshot = await api("operator").snapshot();
		const connection = snapshot.connections.find(
			(item) => item.id === added.body.id,
		);
		expect(connection).toMatchObject({
			transport: "stdio",
			url: "",
			command: `${process.execPath} ${script}`,
			environment: ["FIXTURE_TOKEN"],
		});
		expect(JSON.stringify(snapshot)).not.toContain("stored-secret-value");
		expect(
			(await api("member").snapshot()).connections.map((item) => item.id),
		).not.toContain(added.body.id);
		await expect(
			api("operator").verify({ id: added.body.id }),
		).resolves.toMatchObject({
			tools: ["echo", "environment", "hang", "create_issue"],
		});
	});

	it("serves a command's granted tools to an agent and refuses it once turned off", async () => {
		const added = await addLocalCommand("operator", {
			command: process.execPath,
			args: [script],
			label: "Local files",
		});
		expect(added.status).toBe(200);
		const device = await api("operator").addDevice({ label: "Laptop" });
		const agent = await api("operator").addAgent({
			label: "Editor",
			deviceId: device.id,
			expiresInDays: 1,
		});
		await api("operator").saveGrant({
			agentId: agent.id,
			connectionId: added.body.id,
			rules: {
				full: false,
				allow: { tools: ["echo"], resources: [], prompts: [] },
				block: { tools: [], resources: [], prompts: [] },
			},
		});
		const tools = async () => {
			const client = new Client({ name: "agent", version: "1" });
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
					requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
				}),
			);
			try {
				const names = (await client.listTools()).tools
					.map((tool) => tool.name)
					.filter((name) => name.includes("__"));
				const result = names.length
					? await client.callTool({
							name: names[0] ?? "",
							arguments: { text: "hello" },
						})
					: undefined;
				return { names, result };
			} finally {
				await client.close();
			}
		};
		const on = await tools();
		expect(on.names).toEqual(["local_files__echo"]);
		expect(on.result?.content).toEqual([
			{
				type: "text",
				text: expect.stringMatching(/^echo \d+: \{"text":"hello"\}$/),
			},
		]);
		const activity = (await api("operator").snapshot()).activity;
		expect(
			activity.some(
				(row) =>
					row.method === "tools/call" &&
					row.target === "echo" &&
					row.outcome === "forwarded" &&
					row.origin === "agent",
			),
		).toBe(true);

		await restart("off");
		expect((await api("operator").snapshot()).localCommands).toBe(false);
		const off = await addLocalCommand("operator", {
			command: process.execPath,
			args: [script],
		});
		expect(off.status).toBe(403);
		expect(off.body.message).toContain("Local commands are turned off");
		// Left out of the agent's tools rather than failing its other connections.
		expect((await tools()).names).toEqual([]);
		await expect(api("operator").verify({ id: added.body.id })).rejects.toThrow(
			"Local commands are turned off",
		);
		await restart("on");
	}, 60_000);
});
