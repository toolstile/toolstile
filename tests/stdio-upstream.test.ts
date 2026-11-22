import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, expect, it, vi } from "vitest";
import {
	type ApprovalBegin,
	ApprovalRequiredError,
	agentToolCatalog,
	emptyRules,
	exposedName,
	handleMcp,
	inspect,
	invoke,
	LocalCommandError,
	type Operation,
	type Rules,
	type Runtime,
	UpstreamUnavailableError,
	type Upstream,
} from "../packages/gateway/src/index";

const script = resolve("tests/fixtures/stdio-server.mjs");
const command = (env: Record<string, string> = {}, args: string[] = []) => ({
	command: process.execPath,
	args: [script, ...args],
	env,
});
function upstream(
	rules: Rules[] = [{ ...emptyRules(), full: true }],
	env: Record<string, string> = {},
	args: string[] = [],
): Upstream {
	return {
		id: "22222222-2222-2222-2222-222222222222",
		label: "Files",
		namespace: "files",
		url: "",
		transport: "stdio",
		headers: {},
		command: command(env, args),
		rules,
	};
}
/** Approvals in memory: begin creates a pending request, `approve` lets the next begin claim it. */
function approvals() {
	const rows: { id: string; binding: string; status: string }[] = [];
	const events: string[] = [];
	const expiresAt = new Date(Date.now() + 60_000);
	return {
		rows,
		events,
		approve() {
			for (const row of rows)
				if (row.status === "pending") row.status = "approved";
		},
		store: {
			async begin(request): Promise<ApprovalBegin> {
				const row = rows.find(
					(entry) =>
						entry.binding === request.binding &&
						["pending", "approved", "claimed"].includes(entry.status),
				);
				if (row?.status === "approved") {
					row.status = "claimed";
					return { kind: "permit", id: row.id };
				}
				if (row) return { kind: "pending", id: row.id, expiresAt };
				const id = `request-${rows.length + 1}`;
				rows.push({ id, binding: request.binding, status: "pending" });
				return { kind: "pending", id, expiresAt };
			},
			async release(id) {
				events.push(`release ${id}`);
			},
			async settle(id, _operationId, outcome) {
				events.push(`${outcome} ${id}`);
				const row = rows.find((entry) => entry.id === id);
				if (row) row.status = outcome;
			},
		} satisfies NonNullable<Runtime["approvals"]>,
	};
}
function runtime(source: Upstream, extra: Partial<Runtime> = {}) {
	const admitted: Operation[] = [];
	const recorded: { operation: Operation; outcome: string }[] = [];
	const value: Runtime = {
		connections: async () => [source],
		admit: async (operation) => {
			admitted.push(operation);
		},
		record: async (operation, outcome) => {
			recorded.push({ operation, outcome });
		},
		validateDestination: async () => {
			throw new Error("A local command has no network destination");
		},
		validateCommand: async () => {},
		...extra,
	};
	return { runtime: value, admitted, recorded };
}
const text = (result: unknown) =>
	(result as { content: { text: string }[] }).content[0]?.text ?? "";

afterEach(() => {
	vi.unstubAllEnvs();
});

it("lists and calls a local command's tools, admitting and recording each operation", async () => {
	const source = upstream();
	const f = runtime(source);
	const tools = await agentToolCatalog(f.runtime, source);
	expect(tools.map((tool) => tool.name)).toEqual([
		"echo",
		"environment",
		"hang",
		"create_issue",
	]);
	const result = await invoke(
		f.runtime,
		source,
		"tools/call",
		"echo",
		(client) => client.callTool({ name: "echo", arguments: { text: "hi" } }),
	);
	expect(text(result)).toMatch(/^echo \d+: \{"text":"hi"\}$/);
	// The handshake is maintenance; the list and the call are operations, each admitted once.
	expect(f.admitted.map((operation) => operation.method)).toEqual([
		"tools/list",
		"tools/call",
	]);
	expect(f.admitted[1]).toMatchObject({
		connectionId: source.id,
		target: "echo",
	});
	expect(
		f.recorded.map(({ operation, outcome }) => [operation.method, outcome]),
	).toEqual([
		["tools/list", "forwarded"],
		["tools/call", "forwarded"],
	]);
});

it("never starts a local command the runtime does not allow", async () => {
	const source = upstream();
	const refused = runtime(source, {
		validateCommand: async () => {
			throw new Error("Local commands are turned off on this server");
		},
	});
	await expect(
		invoke(refused.runtime, source, "tools/list", undefined, (client) =>
			client.listTools(),
		),
	).rejects.toThrow("Local commands are turned off on this server");
	const missing = runtime(source, { validateCommand: undefined });
	await expect(
		invoke(missing.runtime, source, "tools/list", undefined, (client) =>
			client.listTools(),
		),
	).rejects.toThrow("Local commands are turned off on this server");
	expect([...refused.admitted, ...missing.admitted]).toEqual([]);
	expect([...refused.recorded, ...missing.recorded]).toEqual([]);
});

it("gives the child only the configured variables and a minimal base", async () => {
	vi.stubEnv("TOOLSTILE_TEST_SERVER_SECRET", "server-only-value");
	const source = upstream(undefined, { FIXTURE_TOKEN: "configured-token" });
	const f = runtime(source);
	const result = await invoke(
		f.runtime,
		source,
		"tools/call",
		"environment",
		(client) => client.callTool({ name: "environment", arguments: {} }),
	);
	const environment = JSON.parse(text(result)) as Record<string, string>;
	expect(environment.FIXTURE_TOKEN).toBe("configured-token");
	expect(environment.PATH).toBe(process.env.PATH);
	expect(environment.TOOLSTILE_TEST_SERVER_SECRET).toBeUndefined();
	expect(environment.ENCRYPTION_KEY).toBeUndefined();
	expect(environment.DATABASE_URL).toBeUndefined();
	expect(
		Object.keys(environment).filter(
			(name) =>
				![
					"FIXTURE_TOKEN",
					"HOME",
					"LOGNAME",
					"PATH",
					"SHELL",
					"TERM",
					"USER",
					// macOS adds this to every process it starts.
					"__CF_USER_TEXT_ENCODING",
				].includes(name),
		),
	).toEqual([]);
});

it("stops a child that does not answer before the request times out", async () => {
	const directory = await mkdtemp(join(tmpdir(), "toolstile-stdio-"));
	try {
		const source = upstream();
		const f = runtime(source);
		const pidFile = join(directory, "pid");
		await expect(
			invoke(f.runtime, source, "tools/call", "hang", (client) =>
				client.callTool(
					{ name: "hang", arguments: { text: pidFile } },
					{ timeout: 500 },
				),
			),
		).rejects.toThrow(/timed out/i);
		const pid = Number(await readFile(pidFile, "utf8"));
		expect(pid).toBeGreaterThan(0);
		// invoke closed the client: standard input closed, then SIGTERM.
		expect(() => process.kill(pid, 0)).toThrow();
		expect(f.recorded.at(-1)).toMatchObject({
			operation: { method: "tools/call", target: "hang" },
			outcome: "upstream_error",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 15_000);

it("explains a command that exits before the handshake without showing secrets", async () => {
	const source = upstream(
		undefined,
		{ FIXTURE_TOKEN: "very-secret-token-value" },
		["--fail"],
	);
	const f = runtime(source);
	const error = await inspect(f.runtime, source).catch((reason) => reason);
	expect(error).toBeInstanceOf(UpstreamUnavailableError);
	expect(error.message).toMatch(/^Couldn't start Files: /);
	expect(error.message).toContain("fixture cannot start; token [redacted]");
	expect(error.message).not.toContain("very-secret-token-value");
	expect(error.cause).toBeInstanceOf(LocalCommandError);
	// Unreachable at the handshake: recorded once, never admitted.
	expect(f.admitted).toEqual([]);
	expect(
		f.recorded.map(({ operation, outcome }) => [operation.method, outcome]),
	).toEqual([["initialize", "upstream_error"]]);
	const missing = upstream();
	missing.command = {
		command: "toolstile-command-that-does-not-exist",
		args: [],
		env: {},
	};
	await expect(inspect(runtime(missing).runtime, missing)).rejects.toThrow(
		"Couldn't start Files: command not found",
	);
});

it("gates an approval-required local tool exactly like a remote one", async () => {
	const memory = approvals();
	const source = upstream([
		{
			...emptyRules(),
			allow: { tools: ["echo"], resources: [], prompts: [] },
			requireApproval: ["create_issue"],
		},
	]);
	const f = runtime(source, { approvals: memory.store });
	const agent = new Client({ name: "agent", version: "1" });
	await agent.connect(
		new StreamableHTTPClientTransport(new URL("http://gateway/mcp"), {
			fetch: async (input, init) =>
				handleMcp(
					new Request(
						input instanceof Request ? input.url : String(input),
						init,
					),
					f.runtime,
				),
		}),
	);
	try {
		const name = exposedName(source, "create_issue");
		const listed = await agent.listTools();
		// Granted tools only: environment and hang are neither allowed nor gated.
		expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
			[exposedName(source, "echo"), name].sort(),
		);
		const pending = await agent.callTool({
			name,
			arguments: { title: "Bug" },
		});
		expect(pending.isError).toBe(true);
		expect(pending._meta?.["toolstile/approval"]).toMatchObject({
			id: "request-1",
			status: "pending",
		});
		expect(JSON.stringify(pending)).not.toContain("Bug");
		expect(
			f.admitted.filter((operation) => operation.method === "tools/call"),
		).toEqual([]);
		memory.approve();
		const approved = await agent.callTool({
			name,
			arguments: { title: "Bug" },
		});
		expect(text(approved)).toMatch(/^create_issue \d+: \{"title":"Bug"\}$/);
		const calls = f.admitted.filter(
			(operation) => operation.method === "tools/call",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.approval?.id).toBe("request-1");
		expect(memory.events).toContain("consumed request-1");
		// The approval was spent: the same call needs a new one.
		const again = await agent.callTool({ name, arguments: { title: "Bug" } });
		expect(again._meta?.["toolstile/approval"]).toMatchObject({
			id: "request-2",
		});
		await expect(
			invoke(f.runtime, source, "tools/call", "create_issue", (client) =>
				client.callTool({ name: "create_issue", arguments: { title: "Bug" } }),
			),
		).rejects.toBeInstanceOf(ApprovalRequiredError);
		// A tool outside the grant is refused before any child starts for it.
		expect(
			await agent
				.callTool({ name: exposedName(source, "environment"), arguments: {} })
				.then(
					(result) => result.isError,
					() => true,
				),
		).toBe(true);
	} finally {
		await agent.close();
	}
}, 30_000);
