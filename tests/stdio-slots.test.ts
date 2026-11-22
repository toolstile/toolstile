import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	closeLocalCommands,
	createMcpGateway,
	emptyRules,
	inspect,
	type LocalCommand,
	LocalCommandTransport,
	type Operation,
	openUpstream,
	type Runtime,
	resourceAlias,
	type Upstream,
} from "../packages/gateway/src/index";
import { type Origin, origins } from "../packages/gateway/src/sessions";

// One file per process: the slot pool and the shutdown state are process-wide.
let directory = "";
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "toolstile-stdio-slots-"));
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});
/** A child that records that it started, ignores its input closing and never answers. */
const sleeper = (marker = join(directory, "unused")): LocalCommand => ({
	command: process.execPath,
	args: [
		"-e",
		`require("fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
	],
	env: {},
});
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const settled = async (promise: Promise<unknown>, wait = 100) => {
	let done = false;
	void promise.then(
		() => (done = true),
		() => (done = true),
	);
	await new Promise((resolve) => setTimeout(resolve, wait));
	return done;
};
async function fill() {
	const held = Array.from(
		{ length: 8 },
		() => new LocalCommandTransport(sleeper()),
	);
	await Promise.all(held.map((transport) => transport.start()));
	return held;
}

it("runs at most eight children; a ninth waits, an aborted waiter never starts", async () => {
	const held = await fill();
	try {
		const marker = join(directory, "ninth");
		const ninth = new LocalCommandTransport(sleeper(marker));
		const waiting = ninth.start();
		const controller = new AbortController();
		const launch = vi.fn(async (spawn: () => void) => spawn());
		const abandoned = new LocalCommandTransport(
			sleeper(join(directory, "abandoned")),
			{ launch, signal: controller.signal },
		);
		const abandonedStart = abandoned.start();
		expect(await settled(waiting)).toBe(false);
		controller.abort();
		await expect(abandonedStart).rejects.toThrow();
		await held[0]?.close();
		await waiting;
		await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
		expect(launch).not.toHaveBeenCalled();
		expect(abandoned.spawned).toBe(false);
		expect(existsSync(join(directory, "abandoned"))).toBe(false);
		await ninth.close();
	} finally {
		await Promise.all(held.map((transport) => transport.close()));
	}
}, 30_000);

it("frees a slot only after the child exits, with one shared close", async () => {
	const held = await fill();
	try {
		const first = held[0];
		if (!first) throw new Error("No child");
		const pidFile = join(directory, "first");
		const slow = new LocalCommandTransport(sleeper(pidFile));
		// Replace the first child with one whose pid this test reads.
		await first.close();
		await slow.start();
		await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
		const pid = Number(readFileSync(pidFile, "utf8"));
		const next = new LocalCommandTransport(sleeper());
		const nextStart = next.start();
		const a = slow.close(),
			b = slow.close();
		expect(a).toBe(b);
		// The child ignores its input closing, so it is still running for about two seconds.
		expect(await settled(nextStart)).toBe(false);
		await nextStart;
		expect(alive(pid)).toBe(false);
		await a;
		await next.close();
	} finally {
		await Promise.all(held.map((transport) => transport.close()));
	}
}, 30_000);

/** A host check in the hook's order: the caller's checks, then the role, then the spawn. */
const allow =
	(role: () => void = () => {}): NonNullable<Runtime["validateCommand"]> =>
	async (_upstream, start) => {
		await start?.check();
		role();
		start?.spawn();
	};
const source = (command: LocalCommand): Upstream => ({
	id: "33333333-3333-3333-3333-333333333333",
	label: "Files",
	namespace: "files",
	url: "",
	transport: "stdio",
	headers: {},
	command,
	rules: [{ ...emptyRules(), full: true }],
});

it("checks authorization again once a queued command gets its slot", async () => {
	const held = await fill();
	try {
		const marker = join(directory, "demoted");
		const upstream = source(sleeper(marker));
		let operator = true;
		const admitted: Operation[] = [];
		const runtime: Runtime = {
			connections: async () => [upstream],
			admit: async (operation) => {
				admitted.push(operation);
			},
			record: async () => {},
			validateDestination: async () => {},
			validateCommand: allow(() => {
				if (!operator) throw new Error("Only instance operators");
			}),
		};
		const opening = openUpstream(
			runtime,
			upstream,
			"tools/list",
			undefined,
			"tools",
		);
		expect(await settled(opening)).toBe(false);
		// Demoted while waiting for a slot.
		operator = false;
		await held[0]?.close();
		await expect(opening).rejects.toThrow("Only instance operators");
		expect(existsSync(marker)).toBe(false);
		expect(admitted).toEqual([]);
	} finally {
		await Promise.all(held.map((transport) => transport.close()));
	}
}, 30_000);

it("never starts a queued command for an agent request that was cancelled", async () => {
	const held = await fill();
	try {
		const marker = join(directory, "cancelled");
		const upstream = source(sleeper(marker));
		const runtime: Runtime = {
			connections: async () => [upstream],
			admit: async () => {},
			record: async () => {},
			validateDestination: async () => {},
			validateCommand: allow(),
		};
		const controller = new AbortController();
		// The agent request being served, as the gateway's request handlers set it.
		const origin = {
			active: true,
			server: { getClientCapabilities: () => ({}) },
			context: { mcpReq: { signal: controller.signal, _meta: {} } },
		} as unknown as Origin;
		const opening = origins.run(origin, () =>
			openUpstream(runtime, upstream, "tools/list", undefined, "tools"),
		);
		expect(await settled(opening)).toBe(false);
		controller.abort();
		await expect(opening).rejects.toThrow();
		await held[0]?.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(marker)).toBe(false);
	} finally {
		await Promise.all(held.map((transport) => transport.close()));
	}
}, 30_000);

it("never starts a local command for a subscription or list-change watch", async () => {
	const marker = join(directory, "watched");
	const upstream = source(sleeper(marker));
	const runtime: Runtime = {
		sessionKey: "owner:agent",
		connections: async () => [upstream],
		admit: async () => {},
		check: async () => {},
		record: async () => {},
		validateDestination: async () => {},
		validateCommand: allow(),
	};
	const gateway = createMcpGateway();
	const listen = (notifications: Record<string, unknown>) =>
		gateway.handle(
			new Request("https://gateway/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": "2026-07-28",
					"Mcp-Method": "subscriptions/listen",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "subscriptions/listen",
					params: {
						notifications,
						_meta: {
							[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
							[CLIENT_INFO_META_KEY]: { name: "watcher", version: "1" },
							[CLIENT_CAPABILITIES_META_KEY]: {},
						},
					},
				}),
			}),
			runtime,
		);
	try {
		for (const notifications of [
			{ toolsListChanged: true },
			{ resourceSubscriptions: [resourceAlias(upstream.id, "file:///notes")] },
		]) {
			const response = await listen(notifications);
			const reader = response.body?.getReader();
			await reader?.read().catch(() => undefined);
			await reader?.cancel().catch(() => undefined);
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(marker)).toBe(false);
	} finally {
		await gateway.close();
	}
});

it("checks the owner's role after the caller's checks, right before the child starts", async () => {
	const marker = join(directory, "demoted-late");
	const upstream = source(sleeper(marker));
	let operator = true,
		checks = 0;
	const runtime: Runtime = {
		connections: async () => [upstream],
		admit: async () => {},
		// Demoted while the caller's access is checked again inside the slot.
		check: async () => {
			if (++checks === 2) operator = false;
		},
		record: async () => {},
		validateDestination: async () => {},
		validateCommand: allow(() => {
			if (!operator) throw new Error("Only instance operators");
		}),
	};
	await expect(
		openUpstream(runtime, upstream, "tools/list", undefined, "tools"),
	).rejects.toThrow("Only instance operators");
	expect(checks).toBe(2);
	expect(existsSync(marker)).toBe(false);
});

it("keeps a slot while a child whose kill failed is still running", async () => {
	const held = await fill();
	// A signal the system refuses: Node reports it as an error event on a live child.
	const kill = vi
		.spyOn(ChildProcess.prototype, "kill")
		.mockImplementation(function (this: ChildProcess) {
			this.emit(
				"error",
				Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
			);
			return false;
		});
	const ninth = new LocalCommandTransport(sleeper(join(directory, "ninth-2")));
	try {
		const closing = held[0]?.close();
		const waiting = ninth.start();
		// The SDK tries SIGTERM and SIGKILL within about four seconds; both fail.
		expect(await settled(waiting, 5_000)).toBe(false);
		kill.mockRestore();
		held[0]?.kill();
		await closing;
		await waiting;
	} finally {
		kill.mockRestore();
		await ninth.close();
		await Promise.all(held.map((transport) => transport.close()));
	}
}, 30_000);

it("never starts a queued command for a dashboard check that was cancelled", async () => {
	const held = await fill();
	try {
		const marker = join(directory, "verify-cancelled");
		const upstream = source(sleeper(marker));
		const runtime: Runtime = {
			connections: async () => [upstream],
			admit: async () => {},
			record: async () => {},
			validateDestination: async () => {},
			validateCommand: allow(),
		};
		const controller = new AbortController();
		const checking = inspect(runtime, upstream, controller.signal);
		expect(await settled(checking)).toBe(false);
		controller.abort();
		await expect(checking).rejects.toThrow();
		await held[0]?.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(marker)).toBe(false);
	} finally {
		await Promise.all(held.map((transport) => transport.close()));
	}
}, 30_000);

it("lets no revocation land between the caller's final check and the spawn", async () => {
	const upstream = source({
		command: process.execPath,
		args: ["-e", "process.exit(0)"],
		env: {},
	});
	// The host's lock that access changes take (an account fence in the instance).
	let held = Promise.resolve();
	const locked = async (work: () => Promise<void>) => {
		const previous = held;
		let release = () => {};
		held = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			await work();
		} finally {
			release();
		}
	};
	const events: string[] = [];
	let granted = true,
		lookups = 0,
		revoking: Promise<void> | undefined;
	/** The owner's role lookup; the final one races a revocation of the caller's grant. */
	const lookup = async () => {
		if (++lookups !== 2) return;
		revoking = locked(async () => {
			granted = false;
			events.push("revoked");
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
	};
	const runtime: Runtime = {
		connections: async () => [upstream],
		admit: async () => {},
		check: async () => {
			if (!granted) throw new Error("Grant revoked");
			events.push("check");
		},
		record: async () => {},
		validateDestination: async () => {},
		validateCommand: async (_upstream, start) => {
			if (!start) {
				await lookup();
				if (lookups === 2) events.push("spawn");
				return;
			}
			await locked(async () => {
				await start.check();
				await lookup();
				start.spawn();
				events.push("spawn");
			});
		},
	};
	await openUpstream(runtime, upstream, "tools/list", undefined, "tools").catch(
		() => undefined,
	);
	await revoking;
	const final = events.lastIndexOf("check");
	expect(events[final + 1]).toBe("spawn");
	expect(events).toContain("revoked");
});

it("returns a missing command's error from an asynchronous launcher", async () => {
	const transport = new LocalCommandTransport(
		{ command: "toolstile-command-that-does-not-exist", args: [], env: {} },
		{
			// The launcher keeps its lock a little after the spawn, as a database one does.
			launch: async (spawn) => {
				spawn();
				await new Promise((resolve) => setTimeout(resolve, 200));
			},
		},
	);
	await expect(transport.start()).rejects.toThrow("command not found");
});

it("refuses queued and new starts at shutdown and stops running children", async () => {
	const held = await fill();
	const marker = join(directory, "queued");
	const queued = new LocalCommandTransport(sleeper(marker));
	const queuedStart = queued.start();
	expect(await settled(queuedStart)).toBe(false);
	const closing = closeLocalCommands();
	await expect(queuedStart).rejects.toThrow("shutting down");
	await closing;
	expect(existsSync(marker)).toBe(false);
	await expect(new LocalCommandTransport(sleeper()).start()).rejects.toThrow(
		"shutting down",
	);
	// Every child was stopped; closing them again is harmless.
	await Promise.all(held.map((transport) => transport.close()));
}, 30_000);
