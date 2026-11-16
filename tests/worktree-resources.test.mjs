import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertIdentity,
	assertStorageOwnership,
	atomicWrite,
	auditResources,
	databaseMatches,
	processes,
	recoverLaunch,
	runLifecycle,
	stopGroup,
	stopOwnedProcesses,
	unprivilegedPort,
	verifyGroup,
	withLock,
} from "../scripts/worktree-resources.mjs";

const fsFaults = vi.hoisted(() => ({ mkdir: false, marker: false }));
vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		mkdirSync(path, ...args) {
			if (fsFaults.mkdir && String(path).includes("/data-task-")) {
				fsFaults.mkdir = false;
				throw Object.assign(new Error("ENOSPC before runtime directory"), {
					code: "ENOSPC",
				});
			}
			return original.mkdirSync(path, ...args);
		},
		writeFileSync(path, ...args) {
			if (
				fsFaults.marker &&
				String(path).includes("/data-task-") &&
				String(path).endsWith("/owner")
			) {
				fsFaults.marker = false;
				throw Object.assign(new Error("ENOSPC before owner marker"), {
					code: "ENOSPC",
				});
			}
			return original.writeFileSync(path, ...args);
		},
	};
});

const dirs = [];
const temp = () => {
	const path = mkdtempSync(join(tmpdir(), "worktree-owner-"));
	dirs.push(path);
	return path;
};
afterEach(() => {
	fsFaults.mkdir = false;
	fsFaults.marker = false;
	for (const path of dirs.splice(0))
		rmSync(path, { recursive: true, force: true });
});
const state = {
	pid: 100,
	pgid: 100,
	port: 4711,
	fingerprint: "original",
	worktree: "/tmp/worktree-a",
};
const leader = {
	pid: 100,
	pgid: 100,
	fingerprint: "original",
	command: "vp dev --host 127.0.0.1 --port 4711",
};
describe("owned process cleanup", () => {
	it("refuses PID reuse without sending a signal", async () => {
		const signals = [];
		await expect(
			stopGroup(state, {
				processes: () => [{ ...leader, fingerprint: "reused" }],
				signal: (...a) => signals.push(a),
			}),
		).rejects.toThrow("identity changed");
		expect(signals).toEqual([]);
	});

	it("refuses a recorded leader that changed process groups before child discovery", async () => {
		const record = { process: state, worktree: state.worktree },
			signals = [],
			saves = [];
		await expect(
			stopOwnedProcesses(record, {
				processes: () => [
					{ ...leader, pgid: 200 },
					{
						pid: 101,
						ppid: 100,
						pgid: 101,
						command: "vite --port 4711",
						fingerprint: "foreign",
					},
				],
				signal: (...args) => signals.push(args),
				save: () => saves.push(true),
			}),
		).rejects.toThrow("identity changed");
		expect(signals).toEqual([]);
		expect(saves).toEqual([]);
		expect(record.appGroup).toBeUndefined();
	});
	it("stops attributable children after their leader exits", async () => {
		let members = [
			{ pid: 101, pgid: 100, command: "vite --port 4711" },
			{ pid: 102, pgid: 100, command: "/tmp/worktree-a/node_modules/esbuild" },
		];
		const signals = [];
		await stopGroup(state, {
			processes: () => members,
			signal: (...a) => {
				signals.push(a);
				members = [];
			},
		});
		expect(signals).toEqual([[100, "SIGTERM"]]);
	});
	it("refuses an ambiguous leaderless group", () => {
		expect(() =>
			verifyGroup(state, [
				{ pid: 101, pgid: 100, command: "unrelated worker" },
			]),
		).toThrow("ambiguous");
	});
	it("escalates only the verified group and verifies exit", async () => {
		let members = [leader];
		const signals = [];
		await stopGroup(state, {
			processes: () => members,
			delay: async () => {},
			signal: (...a) => {
				signals.push(a);
				if (a[1] === "SIGKILL") members = [];
			},
		});
		expect(signals).toEqual([
			[100, "SIGTERM"],
			[100, "SIGKILL"],
		]);
	});
	it("fails when a process survives and treats repeated stop as safe", async () => {
		await expect(
			stopGroup(state, {
				processes: () => [leader],
				delay: async () => {},
				signal: () => {},
			}),
		).rejects.toThrow("survived");
		await stopGroup(state, {
			processes: () => [],
			signal: () => {
				throw new Error("unexpected signal");
			},
		});
	});
});
describe("interrupted startup recovery", () => {
	it("accepts only ports that stop and recovery can handle", () => {
		for (const port of [1024, 4711, 65535])
			expect(unprivilegedPort(port)).toBe(true);
		for (const port of [0, 80, 443, 1023, 65536, 4711.5, "4711", undefined])
			expect(unprivilegedPort(port)).toBe(false);
		expect(() => recoverLaunch({ launchPort: 1023 }, [])).toThrow(
			"invalid startup port",
		);
	});
	it("clears an intent when no launcher or group remains", () => {
		expect(
			recoverLaunch({ launchPort: 4711, launchPid: 100 }, []),
		).toBeUndefined();
		expect(recoverLaunch({ launchPort: 4711 }, [])).toBeUndefined();
	});
	it("recovers only the recorded server group", () => {
		expect(
			recoverLaunch(
				{
					launchPort: 4711,
					launchPid: 100,
					worktree: state.worktree,
					process: state,
				},
				[leader],
			),
		).toEqual(state);
		expect(() =>
			recoverLaunch({ launchPort: 4711, launchPid: 100 }, [
				{ ...leader, pgid: 200 },
			]),
		).toThrow("ambiguous");
		expect(() =>
			recoverLaunch({ launchPort: 4711, launchPid: 100 }, [
				{ ...leader, command: "other --port 4711" },
			]),
		).toThrow("ambiguous");
		expect(() => recoverLaunch({ launchPort: 4711 }, [leader])).toThrow(
			"ambiguous",
		);
	});
});
describe("recorded process groups", () => {
	const app = {
		pid: 101,
		ppid: 100,
		pgid: 101,
		command: "fnm exec pnpm exec vite --port 4711",
		fingerprint: "app",
	};
	const appState = {
		pid: 101,
		pgid: 101,
		fingerprint: "app",
		port: 4711,
		worktree: state.worktree,
	};
	it("stops a recorded legacy app group after its launcher exits", async () => {
		const record = {
			process: state,
			appGroup: appState,
			worktree: state.worktree,
		};
		const signals = [];
		let members = [app];
		await stopOwnedProcesses(record, {
			processes: () => members,
			portOpen: async () => false,
			signal: (...a) => {
				signals.push(a);
				members = [];
			},
		});
		expect(signals).toEqual([[101, "SIGTERM"]]);
	});
	it("retains ownership if the port stays open with no known groups", async () => {
		await expect(
			stopOwnedProcesses(
				{ port: 4711 },
				{ processes: () => [], portOpen: async () => true },
			),
		).rejects.toThrow("still listening");
	});
	it("ignores a released port on repeated stopped cleanup", async () => {
		await stopOwnedProcesses(
			{ phase: "stopped", port: 4711 },
			{ processes: () => [], portOpen: async () => true },
		);
	});
});
describe("ownership records", () => {
	it("replaces private state atomically", () => {
		const file = join(temp(), "records", "a.json");
		atomicWrite(file, { generation: 1 });
		atomicWrite(file, { generation: 2 });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ generation: 2 });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
	});
	it("locks out concurrent commands and releases afterwards", async () => {
		const file = join(temp(), "a.json");
		await withLock(file, async () => {
			await expect(withLock(file, async () => {})).rejects.toThrow(
				"another lifecycle command",
			);
		});
		await withLock(file, async () => {});
	});
	it("recovers stale locks but refuses corrupt locks", async () => {
		const file = join(temp(), "a.json");
		writeFileSync(
			`${file}.lock`,
			JSON.stringify({ pid: 2147483647, fingerprint: "gone" }),
		);
		await withLock(file, async () => {});
		writeFileSync(`${file}.lock`, "{}");
		await expect(withLock(file, async () => {})).rejects.toThrow(
			"unreadable lock",
		);
	});
	it("identifies this process without reading its environment", () => {
		const current = processes().find((p) => p.pid === process.pid);
		expect(current.fingerprint).toHaveLength(64);
		expect(current.start).toBeTruthy();
	});
	it("reads process identities under a non-US parent locale", () => {
		const previous = process.env.LC_ALL;
		try {
			process.env.LC_ALL = "en_GB.UTF-8";
			expect(processes().some((p) => p.pid === process.pid)).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.LC_ALL;
			else process.env.LC_ALL = previous;
		}
	});
	it("never crosses database branch boundaries", () => {
		expect(databaseMatches("toolstile_wt_a_sso", "toolstile_wt_a")).toBe(true);
		expect(databaseMatches("toolstile_wt_a", "toolstile_wt_a")).toBe(true);
		expect(databaseMatches("toolstile_wt_a-b", "toolstile_wt_a")).toBe(false);
	});
	it("refuses changed database clusters", () => {
		const expected = { host: "localhost", port: "5432", system: "old" };
		expect(() =>
			assertIdentity({ ...expected, system: "new" }, expected),
		).toThrow("identity changed");
		expect(() => assertIdentity(expected, undefined)).toThrow("unavailable");
		expect(() => assertIdentity(expected, expected)).not.toThrow();
	});
});

it("refuses storage generation changes and symbolic-link substitution before teardown", () => {
	const parent = realpathSync(temp()),
		directory = join(parent, "owned"),
		generation = "fixture-generation";
	mkdirSync(directory);
	writeFileSync(join(directory, "owner"), generation);
	expect(() => assertStorageOwnership(directory, generation)).not.toThrow();
	expect(() =>
		assertStorageOwnership(directory, "different-generation"),
	).toThrow("owner marker changed");
	const alias = join(parent, "alias");
	symlinkSync(directory, alias);
	expect(() => assertStorageOwnership(alias, generation)).toThrow(
		"owner marker changed",
	);
	rmSync(join(directory, "owner"));
	writeFileSync(join(parent, "marker"), generation);
	symlinkSync(join(parent, "marker"), join(directory, "owner"));
	expect(() => assertStorageOwnership(directory, generation)).toThrow(
		"owner marker changed",
	);
});

const config = {
	envPath: "apps/web/.env",
	appDir: "apps/web",
	portStart: 4400,
};
function lifecycleFixture({ mainOnly = false } = {}) {
	const repo = realpathSync(temp());
	const git = (...args) =>
		execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git("init", "--initial-branch=main");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--allow-empty",
		"-m",
		"fixture",
	);
	const checkout = mainOnly ? repo : join(temp(), "task");
	if (!mainOnly)
		git("worktree", "add", "-b", "runtime/task.with-slashes", checkout);
	mkdirSync(join(repo, "apps/web"), { recursive: true });
	mkdirSync(join(checkout, "apps/web"), { recursive: true });
	const commands = [];
	let fail = false;
	const run = async (ctx, args) => {
		commands.push(args);
		if (fail) {
			fail = false;
			throw new Error("injected installation failure");
		}
		if (args[0] === "run" && args[1] === "db:migrate")
			writeFileSync(join(ctx.directory, "data.sqlite"), "fixture database");
	};
	const options = {
		cwd: checkout,
		run,
		...(mainOnly ? { allowMain: true } : {}),
	};
	const event = (command, settings = config) =>
		runLifecycle(settings, command, options);
	const folder = join(repo, ".git/toolstile-worktree-resources");
	const manifest = () =>
		join(
			folder,
			readdirSync(folder).find((name) => name.endsWith(".json")),
		);
	const record = () => JSON.parse(readFileSync(manifest(), "utf8"));
	return {
		repo,
		checkout,
		options,
		event,
		commands,
		folder,
		manifest,
		record,
		failNext: () => {
			fail = true;
		},
	};
}
describe("provider-neutral lifecycle events", () => {
	it("refuses a port range that stop and recovery would reject, before recording anything", async () => {
		const f = lifecycleFixture();
		for (const portStart of [1000, 1023, 65400, undefined])
			for (const command of ["setup", "resume", "dev"])
				await expect(
					f.event(command, { ...config, portStart }),
				).rejects.toThrow("portStart must leave 200 unprivileged ports");
		expect(existsSync(join(f.checkout, config.envPath))).toBe(false);
		await f.event("setup");
		const origin = new URL(f.record().origin);
		expect(unprivilegedPort(Number(origin.port))).toBe(true);
	});
	it("prepares, repeats, settles, resumes and removes only owned runtime; keeps source", async () => {
		const f = lifecycleFixture();
		await f.event("setup");
		const first = f.record(),
			env = readFileSync(join(f.checkout, config.envPath), "utf8");
		expect(first.version).toBe(2);
		expect(first.process).toBeUndefined();
		expect(first.setupComplete).toBe(true);
		await f.event("setup");
		expect(f.record().id).toBe(first.id);
		expect(readFileSync(join(f.checkout, config.envPath), "utf8")).toBe(env);
		await f.event("stop");
		await f.event("stop");
		expect(f.record().phase).toBe("stopped");
		expect(existsSync(first.server.directory)).toBe(true);
		await f.event("resume");
		await f.event("resume");
		expect(f.record().id).toBe(first.id);
		expect((await f.event("check")).phase).toBe("ready");
		await f.event("teardown");
		await f.event("teardown");
		expect(existsSync(first.server.directory)).toBe(false);
		expect(existsSync(join(f.checkout, config.envPath))).toBe(false);
		expect(existsSync(join(f.checkout, ".git"))).toBe(true);
		expect(
			f.commands.every(
				(args) =>
					args[0] === "install" ||
					(args[0] === "run" && args[1] === "db:migrate"),
			),
		).toBe(true);
		await f.event("setup");
		expect(f.record().id).not.toBe(first.id);
	});
	it("retries failed setup with its original generation", async () => {
		const f = lifecycleFixture();
		f.failNext();
		await expect(f.event("setup")).rejects.toThrow("injected");
		const id = f.record().id;
		await f.event("resume");
		expect(f.record().id).toBe(id);
		await f.event("check");
	});
	it("gives two checkouts independent storage and keys with a localhost origin", async () => {
		const a = lifecycleFixture(),
			b = lifecycleFixture();
		await a.event("setup");
		await b.event("setup");
		expect(a.record().server.directory).not.toBe(b.record().server.directory);
		expect(a.record().origin).toMatch(/^http:\/\/localhost:\d+$/);
		expect(readFileSync(join(a.checkout, config.envPath), "utf8")).not.toBe(
			readFileSync(join(b.checkout, config.envPath), "utf8"),
		);
	});
	it("check is read-only and never creates a missing resource directory", async () => {
		const f = lifecycleFixture();
		await expect(f.event("check")).rejects.toThrow("no lifecycle");
		expect(existsSync(f.folder)).toBe(false);
		await f.event("setup");
		const before = readFileSync(f.manifest(), "utf8");
		await f.event("check");
		expect(readFileSync(f.manifest(), "utf8")).toBe(before);
	});
	it("requires explicit main ownership and never adopts an existing environment", async () => {
		const f = lifecycleFixture({ mainOnly: true });
		await expect(
			runLifecycle(config, "setup", { ...f.options, allowMain: false }),
		).rejects.toThrow("explicit --main");
		await f.event("setup");
		await f.event("check");
		await f.event("teardown");
		writeFileSync(join(f.checkout, config.envPath), "unknown");
		await expect(f.event("setup")).rejects.toThrow("unknown ownership");
		await expect(f.event("teardown")).rejects.toThrow("unknown ownership");
		expect(readFileSync(join(f.checkout, config.envPath), "utf8")).toBe(
			"unknown",
		);
	});
	it("preserves v1, unknown legacy records and resources", async () => {
		const f = lifecycleFixture();
		mkdirSync(f.folder, { recursive: true });
		const file = join(f.folder, "legacy.json");
		atomicWrite(file, { version: 1, worktree: f.checkout });
		const report = await auditResources(config, f.repo);
		expect(report.notes.join(" ")).toContain("legacy or unknown");
		const gitDir = execFileSync(
			"git",
			["-C", f.checkout, "rev-parse", "--path-format=absolute", "--git-dir"],
			{ encoding: "utf8" },
		).trim();
		writeFileSync(join(gitDir, "wt-dev.json"), "{}");
		await expect(f.event("teardown")).rejects.toThrow("legacy ownership");
		expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
	});
	it.each([
		"directory",
		"environment",
		"marker",
		"database",
		"record",
		"holder",
	])(
		"refuses %s symlink substitution without deleting its target",
		async (kind) => {
			const f = lifecycleFixture();
			await f.event("setup");
			const record = f.record();
			const original =
				kind === "directory"
					? record.server.directory
					: kind === "environment"
						? join(f.checkout, config.envPath)
						: kind === "marker"
							? join(record.server.directory, "owner")
							: kind === "database"
								? join(record.server.directory, "data.sqlite")
								: kind === "record"
									? f.manifest()
									: f.folder;
			const moved = join(temp(), "retained");
			renameSync(original, moved);
			symlinkSync(moved, original);
			await expect(f.event("teardown")).rejects.toThrow();
			expect(existsSync(moved)).toBe(true);
		},
	);
	it("refuses directory replacement even when the generation marker was copied", async () => {
		const f = lifecycleFixture();
		await f.event("setup");
		const record = f.record();
		renameSync(record.server.directory, join(temp(), "old"));
		mkdirSync(record.server.directory);
		writeFileSync(join(record.server.directory, "owner"), record.id);
		await expect(f.event("teardown")).rejects.toThrow("substituted");
		expect(existsSync(record.server.directory)).toBe(true);
	});
	it("refuses env edits, marker changes and another Git metadata generation", async () => {
		const f = lifecycleFixture();
		await f.event("setup");
		const record = f.record();
		writeFileSync(join(f.checkout, config.envPath), "edited");
		await expect(f.event("resume")).rejects.toThrow("environment changed");
		record.gitIdentity.ino += 1;
		atomicWrite(f.manifest(), record);
		await expect(f.event("teardown")).rejects.toThrow(
			"resource identity changed",
		);
	});
	it("runs dependency preparation before install and preflights teardown before deletion", async () => {
		const f = lifecycleFixture(),
			calls = [];
		const adapter = {
			...config,
			beforeSetup: async (_ctx, record, save) => {
				calls.push("prepare");
				record.extra = "owned";
				save();
			},
			install: async () => calls.push("install"),
			checkReady: async () => calls.push("check"),
			beforeTeardown: async () => {
				throw new Error("dependency changed");
			},
		};
		await f.event("setup", adapter);
		expect(calls).toEqual(["prepare", "install", "check"]);
		await expect(f.event("teardown", adapter)).rejects.toThrow(
			"dependency changed",
		);
		expect(existsSync(f.record().server.directory)).toBe(true);
		let fail = true;
		const cleanup = {
			...adapter,
			beforeTeardown: undefined,
			afterTeardown: async () => {
				if (fail) {
					fail = false;
					throw new Error("retry cleanup");
				}
			},
		};
		await expect(f.event("teardown", cleanup)).rejects.toThrow("retry cleanup");
		expect(f.record().phase).toBe("tearing-down");
		await f.event("teardown", cleanup);
		expect(existsSync(f.folder)).toBe(true);
	});
});

it("settle stops its recorded real process group and retains task storage", async () => {
	const f = lifecycleFixture();
	await f.event("setup");
	const child = spawn(
		process.execPath,
		["-e", "process.send('ready'); setInterval(()=>{},1000)"],
		{ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
	);
	try {
		await once(child, "message");
		const current = processes().find((p) => p.pid === child.pid);
		const record = f.record();
		record.process = {
			pid: current.pid,
			pgid: current.pgid,
			fingerprint: current.fingerprint,
			worktree: record.worktree,
			port: 65001,
		};
		record.phase = "running";
		atomicWrite(f.manifest(), record);
		const exit = once(child, "exit");
		await f.event("stop");
		await exit;
		expect(f.record().process).toBeUndefined();
		expect(existsSync(record.server.directory)).toBe(true);
		await f.event("resume");
		await f.event("teardown");
	} finally {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		if (child.connected) child.disconnect();
	}
});

it("runs the CLI from checkout CWD with no wt binary or provider inheritance", () => {
	const f = lifecycleFixture(),
		bin = join(temp(), "bin");
	mkdirSync(bin);
	const scripts = join(f.checkout, "scripts");
	mkdirSync(scripts);
	for (const name of [
		"runtime.mjs",
		"worktree-resources.mjs",
		"local-environment.mjs",
	])
		copyFileSync(
			join(import.meta.dirname, "../scripts", name),
			join(scripts, name),
		);
	for (const program of ["git", "ps"])
		symlinkSync(
			execFileSync("which", [program], { encoding: "utf8" }).trim(),
			join(bin, program),
		);
	const vp = join(bin, "vp");
	writeFileSync(
		vp,
		`#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {mkdirSync} from 'node:fs';
if(process.env.SMTP_PASSWORD || process.env.TEST_DATABASE_URL) throw new Error('inherited provider/test settings');
appendFileSync('commands.log',JSON.stringify(process.argv.slice(2))+String.fromCharCode(10));
if(process.argv[2]==='run'&&process.argv[3]==='db:migrate') mkdirSync(process.env.DATABASE_URL,{recursive:true});
`,
	);
	chmodSync(vp, 0o700);
	const env = {
		...process.env,
		PATH: bin,
		SMTP_PASSWORD: "provider-sentinel",
		TEST_DATABASE_URL: "foreign-sentinel",
	};
	const cli = (command) =>
		execFileSync(process.execPath, [join(scripts, "runtime.mjs"), command], {
			cwd: f.checkout,
			env,
			encoding: "utf8",
		});
	expect(JSON.parse(cli("setup")).phase).toBe("ready");
	const first = f.record();
	expect(existsSync(join(first.server.directory, "data.sqlite"))).toBe(true);
	cli("setup");
	cli("stop");
	cli("resume");
	cli("check");
	cli("teardown");
	expect(JSON.parse(cli("teardown")).phase).toBe("absent");
	expect(readFileSync(join(f.checkout, "commands.log"), "utf8")).toContain(
		'"--frozen-lockfile"',
	);
	expect(existsSync(join(bin, "wt"))).toBe(false);
});

describe("review regressions: interrupted launcher identity", () => {
	const foreignLeader = { ...leader, fingerprint: "foreign-launcher" };
	const foreignChild = {
		pid: 101,
		ppid: 100,
		pgid: 101,
		command: "esbuild --service",
		fingerprint: "foreign-child",
	};
	it.each([true, false])(
		"refuses reused original PID before adopting a child (pending=%s)",
		async (pending) => {
			const record = {
				worktree: state.worktree,
				process: { ...state },
				launchPending: pending,
				launchPid: 100,
				launchPort: 4711,
			};
			const before = structuredClone(record),
				signals = [],
				saves = [];
			await expect(
				stopOwnedProcesses(record, {
					processes: () => [foreignLeader, foreignChild],
					portOpen: async () => false,
					signal: (...args) => signals.push(args),
					save: () => saves.push(structuredClone(record)),
				}),
			).rejects.toThrow("identity changed");
			expect(signals).toEqual([]);
			expect(saves).toEqual([]);
			expect(record).toEqual(before);
		},
	);
	it("does not overwrite an already recorded child when the parent PID was reused", async () => {
		const record = {
			worktree: state.worktree,
			process: { ...state },
			appGroup: {
				pid: 101,
				pgid: 101,
				port: 4711,
				worktree: state.worktree,
				fingerprint: "original-child",
			},
			launchPending: true,
			launchPid: 100,
			launchPort: 4711,
		};
		const before = structuredClone(record),
			signals = [];
		await expect(
			stopOwnedProcesses(record, {
				processes: () => [foreignLeader, foreignChild],
				signal: (...args) => signals.push(args),
			}),
		).rejects.toThrow("identity changed");
		expect(signals).toEqual([]);
		expect(record).toEqual(before);
	});
	it("retains a live matching launcher without a saved stable fingerprint", async () => {
		const record = {
			worktree: state.worktree,
			launchPending: true,
			launchPid: 100,
			launchPort: 4711,
		};
		const signals = [],
			saves = [];
		await expect(
			stopOwnedProcesses(record, {
				processes: () => [leader, foreignChild],
				signal: (...args) => signals.push(args),
				save: () => saves.push(true),
			}),
		).rejects.toThrow("stable launcher identity unavailable");
		expect(signals).toEqual([]);
		expect(saves).toEqual([]);
		expect(record.appGroup).toBeUndefined();
	});
});

describe("review regressions: initial resource reservation", () => {
	async function interrupted(stage = "mkdir") {
		const f = lifecycleFixture();
		fsFaults[stage] = true;
		await expect(f.event("setup")).rejects.toMatchObject({ code: "ENOSPC" });
		return f;
	}
	it("resumes the same generation after ENOSPC before mkdir, then tears down", async () => {
		const f = await interrupted(),
			initial = f.record();
		expect(initial.server.progress).toBe("pending");
		expect(initial.server.identity).toBeUndefined();
		expect(existsSync(initial.server.directory)).toBe(false);
		expect(f.commands).toEqual([]);
		await expect(f.event("check")).rejects.toThrow("setup incomplete");
		const audit = await auditResources(config, f.repo);
		expect(audit.issues.join(" ")).toContain("incomplete initializing");
		await f.event("resume");
		expect(f.record().id).toBe(initial.id);
		expect(f.record().server.progress).toBe("ready");
		const file = f.manifest();
		await f.event("check");
		await f.event("teardown");
		expect(existsSync(file)).toBe(false);
	});
	it("tears down only the saved reservation after ENOSPC, preserving unrelated resources", async () => {
		const f = await interrupted(),
			initial = f.record(),
			file = f.manifest();
		const unrelated = join(f.folder, "data-unrelated");
		mkdirSync(unrelated);
		writeFileSync(join(unrelated, "keep"), "foreign");
		const callbacks = [];
		await f.event("teardown", {
			...config,
			beforeTeardown: () => callbacks.push("before"),
			afterTeardown: () => callbacks.push("after"),
		});
		expect(callbacks).toEqual(["before", "after"]);
		expect(existsSync(file)).toBe(false);
		expect(existsSync(initial.server.directory)).toBe(false);
		expect(readFileSync(join(unrelated, "keep"), "utf8")).toBe("foreign");
		await f.event("teardown");
	});
	it.each(["resume", "teardown"])(
		"does not adopt an unrecorded replacement with a copied marker during %s",
		async (command) => {
			const f = await interrupted(),
				initial = f.record();
			mkdirSync(initial.server.directory);
			writeFileSync(join(initial.server.directory, "owner"), initial.id);
			writeFileSync(join(initial.server.directory, "foreign"), "keep");
			const before = readFileSync(f.manifest(), "utf8");
			await expect(f.event(command)).rejects.toThrow(
				"without recorded ownership",
			);
			expect(readFileSync(f.manifest(), "utf8")).toBe(before);
			expect(
				readFileSync(join(initial.server.directory, "foreign"), "utf8"),
			).toBe("keep");
			expect(f.commands).toEqual([]);
		},
	);
	it.each(["resume", "teardown"])(
		"retains a substituted pending directory symlink during %s",
		async (command) => {
			const f = await interrupted(),
				target = realpathSync(temp());
			writeFileSync(join(target, "keep"), "foreign");
			symlinkSync(target, f.record().server.directory);
			await expect(f.event(command)).rejects.toThrow(
				"without recorded ownership",
			);
			expect(readFileSync(join(target, "keep"), "utf8")).toBe("foreign");
		},
	);
	it.each(["resume", "teardown"])(
		"retains an unowned environment introduced before %s",
		async (command) => {
			const f = await interrupted(),
				path = join(f.checkout, config.envPath);
			writeFileSync(path, "foreign");
			await expect(f.event(command)).rejects.toThrow(
				"without initialized ownership",
			);
			expect(readFileSync(path, "utf8")).toBe("foreign");
		},
	);
	it.each(["resume", "teardown"])(
		"recovers recorded directory creation before marker failure via %s",
		async (command) => {
			const f = await interrupted("marker"),
				initial = f.record();
			expect(initial.server.progress).toBe("directory-created");
			expect(initial.server.identity).toBeTruthy();
			expect(existsSync(join(initial.server.directory, "owner"))).toBe(false);
			await f.event(command);
			if (command === "resume") {
				expect(f.record().id).toBe(initial.id);
				await f.event("check");
				await f.event("teardown");
			}
			expect(existsSync(initial.server.directory)).toBe(false);
		},
	);
	it("refuses a substituted initial directory even with an identical marker", async () => {
		const f = await interrupted("marker"),
			initial = f.record();
		renameSync(initial.server.directory, join(temp(), "original"));
		mkdirSync(initial.server.directory);
		writeFileSync(join(initial.server.directory, "owner"), initial.id);
		await expect(f.event("resume")).rejects.toThrow(
			"resource identity changed",
		);
		await expect(f.event("teardown")).rejects.toThrow(
			"resource identity changed",
		);
	});
	it("retains unknown contents added before marker completion", async () => {
		const f = await interrupted("marker"),
			directory = f.record().server.directory;
		writeFileSync(join(directory, "foreign"), "keep");
		await expect(f.event("resume")).rejects.toThrow("unknown resources");
		await expect(f.event("teardown")).rejects.toThrow("unknown resources");
		expect(readFileSync(join(directory, "foreign"), "utf8")).toBe("keep");
	});
	it("rejects progress substitution on a completed generation", async () => {
		const f = lifecycleFixture();
		await f.event("setup");
		const record = f.record();
		record.server.progress = "pending";
		atomicWrite(f.manifest(), record);
		await expect(f.event("teardown")).rejects.toThrow(
			"invalid runtime initialization progress",
		);
		expect(existsSync(record.server.directory)).toBe(true);
	});
});
