// Provider-neutral local runtime ownership. Importing this module performs no I/O.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { parseEnv } from "node:util";
import {
	isolatedWorktreeEnvironment,
	localOrigin,
	runtimeEnvironment,
	serializeEnvironment,
} from "./local-environment.mjs";

export const MANIFEST_VERSION = 2;
const namespace = "toolstile-worktree-resources";
/** Historical on-disk names kept so existing task records and storage stay valid.
 * The database path is a PGlite data directory, not a SQLite file. */
const DATABASE_NAME = "data.sqlite";
const STORAGE_KIND = "sqlite";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const output = (program, args, cwd, env) =>
	execFileSync(program, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15000,
	}).trim();
const git = (args, cwd) => output("git", ["-C", cwd, ...args]);
const fingerprint = (text) => createHash("sha256").update(text).digest("hex");
export function processes() {
	const result = output(
		"ps",
		["-Aww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="],
		undefined,
		{ ...process.env, LC_ALL: "C" },
	)
		.split("\n")
		.flatMap((line) => {
			const m = line.match(
				/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/,
			);
			return m && !/^[ZE]/.test(m[4])
				? [
						{
							pid: Number(m[1]),
							ppid: Number(m[2]),
							pgid: Number(m[3]),
							start: m[5],
							command: m[6],
							fingerprint: fingerprint(`${m[5]} ${m[6]}`),
						},
					]
				: [];
		});
	if (!result.some((p) => p.pid === process.pid))
		throw new Error("process inspection unavailable: current process missing");
	return result;
}
export function verifyGroup(state, list) {
	const current = list.find((p) => p.pid === state.pid);
	if (
		current &&
		(current.pgid !== state.pgid || current.fingerprint !== state.fingerprint)
	)
		throw new Error("process identity changed; refusing group signal");
	const members = list.filter((p) => p.pgid === state.pgid);
	if (!members.length) return [];
	const leader = members.find((p) => p.pid === state.pid);
	if (leader) {
		if (leader.fingerprint !== state.fingerprint)
			throw new Error("process identity changed; refusing group signal");
	} else if (
		!members.every(
			(p) =>
				p.command.includes(state.worktree) ||
				new RegExp(`(?:^|\\D)${state.port}(?:\\D|$)`).test(p.command),
		)
	) {
		throw new Error(
			"group leader is gone and remaining process ownership is ambiguous",
		);
	}
	return members;
}
export async function stopGroup(state, adapters = {}) {
	const list = adapters.processes ?? processes;
	const signal =
		adapters.signal ?? ((pgid, value) => process.kill(-pgid, value));
	const sleep = adapters.delay ?? delay;
	if (!verifyGroup(state, list()).length) return;
	signal(state.pgid, "SIGTERM");
	for (let i = 0; i < 40; i++) {
		if (!list().some((p) => p.pgid === state.pgid)) return;
		await sleep(250);
	}
	if (verifyGroup(state, list()).length) signal(state.pgid, "SIGKILL");
	for (let i = 0; i < 20; i++) {
		if (!list().some((p) => p.pgid === state.pgid)) return;
		await sleep(100);
	}
	throw new Error("process group survived cleanup");
}
export function atomicWrite(file, value) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}
function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw new Error(`Cannot read ownership record ${file}: ${error.message}`);
	}
}
export async function withLock(file, callback) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const lock = `${file}.lock`;
	const self = processes().find((p) => p.pid === process.pid);
	if (!self) throw new Error("cannot establish cleanup lock owner");
	const temporary = `${lock}.${randomUUID()}.tmp`;
	writeFileSync(
		temporary,
		JSON.stringify({ pid: self.pid, fingerprint: self.fingerprint }),
		{ flag: "wx", mode: 0o600 },
	);
	try {
		try {
			linkSync(temporary, lock);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const reaper = `${lock}.reaper`;
			let guard;
			try {
				guard = openSync(reaper, "wx", 0o600);
			} catch (error) {
				if (error.code === "EEXIST")
					throw new Error(
						`cleanup lock recovery already active or interrupted: inspect ${reaper}`,
					);
				throw error;
			}
			try {
				const owner = readJson(lock);
				if (!owner || !Number.isInteger(owner.pid) || !owner.fingerprint)
					throw new Error(`unreadable lock ${lock}; inspect it manually`);
				if (
					processes().some(
						(p) => p.pid === owner.pid && p.fingerprint === owner.fingerprint,
					)
				)
					throw new Error(
						"another lifecycle command is running; retry after it finishes",
					);
				rmSync(lock);
				linkSync(temporary, lock);
			} finally {
				closeSync(guard);
				rmSync(reaper, { force: true });
			}
		}
	} finally {
		rmSync(temporary, { force: true });
	}
	try {
		return await callback();
	} finally {
		rmSync(lock, { force: true });
	}
}
function ownedLauncher(record, list) {
	const launcher = record.launchPending
		? recoverLaunch(record, list)
		: record.process;
	if (launcher) verifyGroup(launcher, list);
	// Records written by the older two-group launcher may also own a child group.
	// Validate all recorded groups before signalling either one.
	if (record.appGroup) verifyGroup(record.appGroup, list);
	return launcher;
}
export async function stopOwnedProcesses(record, adapters = {}) {
	const list = adapters.processes ?? processes;
	const open = adapters.portOpen ?? portOpen;
	const stop = adapters.stopGroup ?? ((state) => stopGroup(state, adapters));
	const launcher = ownedLauncher(record, list());
	if (launcher) await stop(launcher);
	if (record.appGroup) await stop(record.appGroup);
	const port = record.port ?? record.launchPort ?? record.process?.port;
	if (port && record.phase !== "stopped" && (await open(port)))
		throw new Error(
			`owned port ${port} still listening; ownership record retained`,
		);
}
// Recovery may use only a previously captured stable identity, never the current
// fingerprint of a PID that happens to run a matching command/port.
export function recoverLaunch(record, list) {
	const port = record.launchPort;
	if (!Number.isInteger(port) || port < 1024 || port > 65535)
		throw new Error("invalid startup port; inspect ownership record");
	const matches = (p) => new RegExp(`--port ${port}(?:\\s|$)`).test(p.command);
	const group = list.filter((p) => p.pgid === record.launchPid);
	const candidates = list.filter(matches);
	if (!group.length && !candidates.length) return undefined;
	const saved = record.process;
	const leader = group.find(
		(p) => p.pid === record.launchPid && p.pid === p.pgid,
	);
	if (
		!saved ||
		saved.pid !== record.launchPid ||
		saved.pgid !== saved.pid ||
		saved.port !== port ||
		saved.worktree !== record.worktree ||
		!leader ||
		!leader.command.includes("vite") ||
		!matches(leader) ||
		candidates.some((p) => p.pgid !== leader.pgid)
	)
		throw new Error(
			"interrupted startup ownership is ambiguous; stable launcher identity unavailable",
		);
	if (leader.fingerprint !== saved.fingerprint)
		throw new Error("process identity changed; refusing startup recovery");
	return saved;
}
export async function stopResources(ctx, record) {
	await stopOwnedProcesses(record);
	record.port = undefined;
	record.process = undefined;
	record.appGroup = undefined;
	record.launchPending = false;
	record.launchPid = undefined;
	record.launchPort = undefined;
	record.phase = record.phase === "tearing-down" ? "tearing-down" : "stopped";
	save(ctx, record);
}
const portOpen = (port, host = "127.0.0.1") =>
	new Promise((done) => {
		const socket = createConnection({ port, host });
		socket.setTimeout(1000);
		socket.once("connect", () => {
			socket.destroy();
			done(true);
		});
		socket.once("error", () => {
			socket.destroy();
			done(false);
		});
		socket.once("timeout", () => {
			socket.destroy();
			done(false);
		});
	});
/** A stable per-checkout default port, used for the generated local origin. */
function defaultPort(ctx) {
	let hash = 0;
	for (const char of ctx.name) hash = (hash * 31 + char.charCodeAt(0)) % 200;
	return { hash, port: ctx.config.portStart + hash };
}
async function freePort(ctx) {
	const { hash } = defaultPort(ctx);
	for (let offset = 0; offset < 200; offset++) {
		const port = ctx.config.portStart + ((hash + offset) % 200);
		if (!unprivilegedPort(port)) continue;
		if (
			await new Promise((done) => {
				const s = createServer();
				s.once("error", () => done(false));
				s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
			})
		)
			return port;
	}
	throw new Error("no free development port");
}
/** Every recorded or selected dev port must be one stop and recovery accept. */
export function unprivilegedPort(port) {
	return Number.isInteger(port) && port >= 1024 && port <= 65535;
}
function requestedPort(value) {
	if (value === undefined || value === "") return undefined;
	const port = Number(value);
	if (!unprivilegedPort(port))
		throw new Error("PORT must be an unprivileged TCP port (1024-65535)");
	return port;
}
/** The browser-facing origin: an explicit BETTER_AUTH_URL, then the adapter's
 * fallback, then plain localhost on the listening port. Always a local origin. */
function developmentOrigin(source, port, fallback) {
	const explicit = source.BETTER_AUTH_URL || fallback?.(source);
	return localOrigin(explicit || `http://localhost:${port}`).origin;
}
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
async function dev(ctx, record) {
	binding(ctx);
	assertReady(ctx, record);
	if (
		!record.launchPending &&
		record.process &&
		verifyGroup(record.process, processes()).length
	)
		throw new Error(
			"owned dev server is already running; stop it before starting another",
		);
	if (
		record.launchPending ||
		record.process ||
		record.appGroup ||
		["starting", "running"].includes(record.phase)
	)
		await stopResources(ctx, record);
	const env = parseEnv(readFileSync(ctx.envPath, "utf8"));
	const port = requestedPort(process.env.PORT) ?? (await freePort(ctx));
	const host = process.env.HOST || "127.0.0.1";
	const probeHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
	const origin = developmentOrigin(process.env, port, ctx.config.originFallback);
	record.port = port;
	record.launchPort = port;
	record.launchPid = undefined;
	record.launchPending = true;
	record.phase = "starting";
	save(ctx, record);
	// The server leads its own process group so stop/teardown can signal exactly it.
	const child = spawn(
		"pnpm",
		[
			"exec",
			"vp",
			"dev",
			"--host",
			host,
			"--port",
			String(port),
			"--strictPort",
		],
		{
			cwd: join(ctx.dir, ctx.config.appDir),
			detached: true,
			stdio: "inherit",
			env: {
				...runtimeEnvironment(),
				...env,
				BETTER_AUTH_URL: origin,
				HOST: host,
				PORT: String(port),
				__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: new URL(origin).hostname,
				TOOLSTILE_CATALOG_FETCH: "off",
			},
		},
	);
	let forwarded = false;
	const forward = (signal) => {
		forwarded = true;
		try {
			if (child.pid) process.kill(-child.pid, signal);
		} catch {
			/* The group already exited. */
		}
	};
	for (const signal of signals) process.on(signal, forward);
	const exited = new Promise((done) => {
		child.once("exit", (code, signal) => done({ code, signal }));
		child.once("error", () => done({ code: 1, signal: null }));
	});
	const finished = exited.then((result) => {
		for (const signal of signals) process.off(signal, forward);
		return forwarded ? 0 : (result.code ?? 1);
	});
	record.launchPid = child.pid;
	save(ctx, record);
	let spawnError;
	child.on("error", (error) => {
		spawnError = error;
	});
	try {
		let previous;
		for (let i = 0; i < 30; i++) {
			if (spawnError) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error("dev server exited before stable identity");
			const leader = processes().find((p) => p.pid === child.pid);
			if (
				leader &&
				leader.pgid === leader.pid &&
				leader.command.includes("vite") &&
				leader.command.includes(`--port ${port}`)
			) {
				if (previous === leader.fingerprint) {
					record.process = {
						pid: leader.pid,
						pgid: leader.pgid,
						fingerprint: leader.fingerprint,
						worktree: ctx.dir,
						port,
					};
					save(ctx, record);
					break;
				}
				previous = leader.fingerprint;
			} else previous = undefined;
			await delay(100);
		}
		if (!record.process)
			throw new Error(
				"stable spawn identity unavailable; retained startup intent requires manual inspection",
			);
		record.launchPending = false;
		save(ctx, record);
		if (process.env.TOOLSTILE_LIFECYCLE_FAULT === "after-spawn")
			throw new Error("injected startup failure");
		for (let i = 0; i < 120; i++) {
			if (await portOpen(port, probeHost)) {
				record.phase = "running";
				save(ctx, record);
				console.log(`Dev server running: ${origin}`);
				return {
					name: ctx.name,
					phase: record.phase,
					origin,
					pid: child.pid,
					finished,
				};
			}
			if (!verifyGroup(record.process, processes()).length)
				throw new Error("dev server exited");
			await delay(500);
		}
		throw new Error("dev server startup timed out");
	} catch (error) {
		if (spawnError && !child.pid) record.launchPending = false;
		save(ctx, record);
		try {
			await stopResources(ctx, record);
		} catch (e) {
			console.error(
				`cleanup incomplete: ${e.message}; run the runtime stop command before retrying`,
			);
		}
		for (const signal of signals) process.off(signal, forward);
		throw error;
	}
}

function present(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
function canonical(path) {
	if (realpathSync(path) !== resolve(path) || lstatSync(path).isSymbolicLink())
		throw new Error(`noncanonical or substituted path: ${path}`);
	return path;
}
const fileIdentity = (path) => {
	const stat = lstatSync(path);
	return { dev: stat.dev, ino: stat.ino };
};
function sameIdentity(path, expected) {
	canonical(path);
	if (
		!expected ||
		JSON.stringify(fileIdentity(path)) !== JSON.stringify(expected)
	)
		throw new Error(`resource identity changed: ${path}`);
}
export function worktrees(repo) {
	return git(["worktree", "list", "--porcelain", "-z"], repo)
		.split("\0\0")
		.filter(Boolean)
		.map((block) => {
			const lines = block.split("\0");
			return {
				path: lines.find((line) => line.startsWith("worktree "))?.slice(9),
				branch: lines
					.find((line) => line.startsWith("branch refs/heads/"))
					?.slice(18),
				prunable: lines.some((line) => line.startsWith("prunable")),
			};
		});
}
function context(config, cwd) {
	const dir = canonical(git(["rev-parse", "--show-toplevel"], cwd));
	if (present(join(dir, config.appDir))) canonical(join(dir, config.appDir));
	const common = canonical(
		git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir),
	);
	const gitDir = canonical(
		git(["rev-parse", "--path-format=absolute", "--git-dir"], dir),
	);
	const main = worktrees(dir)[0]?.path;
	if (!main || git(["rev-parse", "--is-bare-repository"], dir) !== "false")
		throw new Error("a registered non-bare checkout is required");
	const name = `task-${fingerprint(`${dir}\0${gitDir}`).slice(0, 20)}`;
	const folder = join(common, namespace);
	if (present(folder)) canonical(folder);
	const envPath = resolve(dir, config.envPath);
	if (isAbsolute(config.envPath) || relative(dir, envPath).startsWith(".."))
		throw new Error("environment path must be inside this checkout");
	canonical(dirname(envPath));
	return {
		config,
		dir,
		main: canonical(main),
		common,
		gitDir,
		name,
		folder,
		file: join(folder, `${name}.json`),
		directory: join(folder, `data-${name}`),
		envPath,
	};
}
function binding(ctx) {
	canonical(ctx.dir);
	canonical(ctx.common);
	canonical(ctx.gitDir);
	if (
		git(["rev-parse", "--path-format=absolute", "--git-dir"], ctx.dir) !==
			ctx.gitDir ||
		!worktrees(ctx.dir).some((tree) => tree.path === ctx.dir && !tree.prunable)
	)
		throw new Error("checkout Git binding changed");
}
function save(ctx, record) {
	binding(ctx);
	canonical(ctx.folder);
	if (present(ctx.file)) canonical(ctx.file);
	atomicWrite(ctx.file, record);
}
function validateRecord(ctx, record) {
	if (
		record.version !== MANIFEST_VERSION ||
		!/^[a-f0-9-]{36}$/.test(record.id) ||
		record.name !== ctx.name ||
		record.main !== ctx.main ||
		record.worktree !== ctx.dir ||
		record.common !== ctx.common ||
		record.gitDir !== ctx.gitDir ||
		record.server?.kind !== STORAGE_KIND ||
		record.server.directory !== ctx.directory ||
		record.environment?.path !== ctx.envPath
	)
		throw new Error(
			"ownership record is incompatible or belongs to another worktree generation; retained for manual inspection",
		);
	const progress = record.server.progress ?? "ready";
	if (
		!["pending", "directory-created", "ready"].includes(progress) ||
		(progress !== "pending" && !record.server.identity) ||
		(progress === "pending" && record.server.identity) ||
		(progress !== "ready" &&
			(record.setupComplete ||
				record.environment.identity ||
				record.origin ||
				record.process ||
				record.appGroup ||
				record.launchPending ||
				record.launchPid ||
				record.launchPort ||
				record.port ||
				!["initializing", "stopped", "tearing-down"].includes(record.phase)))
	)
		throw new Error(
			"invalid runtime initialization progress; resources retained",
		);
	sameIdentity(ctx.gitDir, record.gitIdentity);
	for (const port of [record.port, record.launchPort])
		if (port !== undefined && port !== null && !unprivilegedPort(port))
			throw new Error("invalid recorded port; inspect ownership record");
	for (const owned of [record.process, record.appGroup].filter(Boolean)) {
		if (
			!Number.isInteger(owned.pid) ||
			owned.pid < 2 ||
			owned.pgid !== owned.pid ||
			!Number.isInteger(owned.port) ||
			owned.port < 1024 ||
			owned.port > 65535 ||
			owned.worktree !== ctx.dir ||
			!/^[a-f0-9]{64}$/.test(owned.fingerprint)
		)
			throw new Error("invalid process ownership record");
	}
	return record;
}
/** Canonical paths and a generation marker are mandatory, even during retries. */
export function assertStorageOwnership(directory, generation, identity) {
	try {
		canonical(directory);
		if (!lstatSync(directory).isDirectory()) throw new Error("not a directory");
		const marker = join(directory, "owner");
		canonical(marker);
		if (
			!lstatSync(marker).isFile() ||
			readFileSync(marker, "utf8") !== generation
		)
			throw new Error("generation changed");
		if (identity) sameIdentity(directory, identity);
	} catch {
		throw new Error(
			"storage owner marker changed or directory substituted; refusing cleanup",
		);
	}
}
function assertEnvironment(ctx, record) {
	const env = record.environment;
	sameIdentity(ctx.envPath, env.identity);
	if (
		!lstatSync(ctx.envPath).isFile() ||
		fingerprint(readFileSync(ctx.envPath, "utf8")) !== env.hash
	)
		throw new Error("environment changed; retained for manual inspection");
	const values = parseEnv(readFileSync(ctx.envPath, "utf8"));
	if (
		values.DATABASE_URL !== join(ctx.directory, DATABASE_NAME) ||
		values.BETTER_AUTH_URL !== record.origin
	)
		throw new Error("environment targets changed");
}
function assertReady(ctx, record) {
	if (
		!record.setupComplete ||
		!["ready", "stopped", "running"].includes(record.phase)
	)
		throw new Error("setup incomplete; run the runtime resume command");
	assertStorageOwnership(ctx.directory, record.id, record.server.identity);
	assertEnvironment(ctx, record);
	if (!present(join(ctx.directory, DATABASE_NAME)))
		throw new Error("PGlite database unavailable; run resume");
	canonical(join(ctx.directory, DATABASE_NAME));
}
function assertInitializingRuntime(ctx, record) {
	const progress = record.server.progress;
	if (progress === "pending") {
		if (present(ctx.directory))
			throw new Error(
				"runtime directory exists without recorded ownership; resources retained",
			);
	} else if (present(ctx.directory)) {
		sameIdentity(ctx.directory, record.server.identity);
		if (!lstatSync(ctx.directory).isDirectory())
			throw new Error("runtime path is not an owned directory");
		// No application work has run yet; only our generation marker is allowed.
		if (readdirSync(ctx.directory).some((name) => name !== "owner"))
			throw new Error(
				"uninitialized runtime contains unknown resources; retained",
			);
		if (present(join(ctx.directory, "owner")))
			assertStorageOwnership(ctx.directory, record.id, record.server.identity);
	} else if (record.phase !== "tearing-down")
		throw new Error("owned initial directory missing; resources retained");
	if (present(ctx.envPath))
		throw new Error(
			"environment exists without initialized ownership; resources retained",
		);
}
function initializeRuntime(ctx, record) {
	assertInitializingRuntime(ctx, record);
	if (record.server.progress === "pending") {
		// An absent reservation conveys no ownership of a future substituted path.
		mkdirSync(ctx.directory, { mode: 0o700 });
		record.server.identity = fileIdentity(ctx.directory);
		record.server.progress = "directory-created";
		save(ctx, record);
	}
	if (!present(join(ctx.directory, "owner")))
		writeFileSync(join(ctx.directory, "owner"), record.id, {
			flag: "wx",
			mode: 0o600,
		});
	assertStorageOwnership(ctx.directory, record.id, record.server.identity);
	record.server.progress = "ready";
	record.phase = "setting-up";
	save(ctx, record);
}
function assertRuntime(ctx, record) {
	if (record.server.progress && record.server.progress !== "ready")
		return assertInitializingRuntime(ctx, record);
	if (present(ctx.directory)) {
		assertStorageOwnership(ctx.directory, record.id, record.server.identity);
		if (present(join(ctx.directory, DATABASE_NAME)))
			canonical(join(ctx.directory, DATABASE_NAME));
	} else if (record.phase !== "tearing-down")
		throw new Error("owned runtime directory missing; inspect manually");
	if (present(ctx.envPath)) assertEnvironment(ctx, record);
	else if (record.environment.identity && record.phase !== "tearing-down")
		throw new Error("owned environment missing; inspect manually");
}
function run(ctx, args) {
	execFileSync("pnpm", args, {
		cwd: ctx.dir,
		stdio: "inherit",
		env: {
			...runtimeEnvironment(),
			...(args[0] !== "install" && present(ctx.envPath)
				? parseEnv(readFileSync(ctx.envPath, "utf8"))
				: {}),
		},
	});
}
function newRecord(ctx) {
	return {
		version: MANIFEST_VERSION,
		id: randomUUID(),
		name: ctx.name,
		main: ctx.main,
		worktree: ctx.dir,
		common: ctx.common,
		gitDir: ctx.gitDir,
		gitIdentity: fileIdentity(ctx.gitDir),
		server: { kind: STORAGE_KIND, directory: ctx.directory, progress: "pending" },
		environment: { path: ctx.envPath },
		phase: "initializing",
		createdAt: new Date().toISOString(),
	};
}
async function prepare(ctx, record, execute) {
	if (record.phase === "tearing-down")
		throw new Error("teardown in progress; retry teardown before setup");
	if (record.server.progress && record.server.progress !== "ready")
		initializeRuntime(ctx, record);
	assertRuntime(ctx, record);
	if (record.process || record.launchPending || record.appGroup) {
		assertReady(ctx, record);
		await ctx.config.checkReady?.(ctx, record);
		return record; // Do not run migrations or installs beneath a running server.
	}
	record.phase = "setting-up";
	save(ctx, record);
	try {
		await ctx.config.beforeSetup?.(ctx, record, () => save(ctx, record));
		assertRuntime(ctx, record);
		if (ctx.config.install) await ctx.config.install(ctx, record);
		else
			await execute(ctx, ["install", "--frozen-lockfile", "--prefer-offline"]);
		if (!record.environment.identity) {
			if (present(ctx.envPath))
				throw new Error(
					"environment exists with unknown ownership; inspect manually",
				);
			// The default origin; `dev` derives the served origin from its environment.
			const origin = localOrigin(
				`http://localhost:${defaultPort(ctx).port}`,
			).origin;
			const env = isolatedWorktreeEnvironment(ctx.config.environment ?? {}, {
				name: ctx.name,
				database: join(ctx.directory, DATABASE_NAME),
				origin,
				...ctx.config.environmentPolicy,
			});
			// The adapter cannot override the task's core targets or independently generated keys.
			env.DATABASE_URL = join(ctx.directory, DATABASE_NAME);
			env.BETTER_AUTH_URL = origin;
			env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
			env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
			const body = serializeEnvironment(env);
			writeFileSync(ctx.envPath, body, { flag: "wx", mode: 0o600 });
			record.environment = {
				path: ctx.envPath,
				hash: fingerprint(body),
				identity: fileIdentity(ctx.envPath),
			};
			record.origin = origin;
			save(ctx, record);
		}
		assertRuntime(ctx, record);
		await execute(ctx, ["db:migrate"]);
		record.setupComplete = true;
		record.phase = "ready";
		assertReady(ctx, record);
		await ctx.config.checkReady?.(ctx, record);
		record.phase = "ready";
		save(ctx, record);
		return record;
	} catch (error) {
		record.phase = "setup-failed";
		save(ctx, record);
		throw error;
	}
}

/** Run an event from a Git checkout; adapters own only their explicitly recorded resources. */
export async function runLifecycle(
	config,
	command,
	{ cwd = process.cwd(), allowMain = false, run: execute = run } = {},
) {
	if (
		!["setup", "resume", "stop", "teardown", "check", "dev"].includes(command)
	)
		throw new Error("unknown lifecycle command");
	const ctx = context(config, cwd);
	binding(ctx);
	// Every port this configuration can select must be one stop and recovery accept.
	if (
		["setup", "resume", "dev"].includes(command) &&
		!(
			unprivilegedPort(config.portStart) &&
			unprivilegedPort(config.portStart + 199)
		)
	)
		throw new Error("portStart must leave 200 unprivileged ports (1024-65535)");
	if (ctx.dir === ctx.main && !allowMain)
		throw new Error("main checkout requires explicit --main / allowMain: true");
	const load = () => {
		if (!present(ctx.file)) return undefined;
		canonical(ctx.file);
		return validateRecord(ctx, readJson(ctx.file));
	};
	if (command === "check") {
		const record = load();
		if (!record) throw new Error("no lifecycle ownership record; run setup");
		assertReady(ctx, record);
		await config.checkReady?.(ctx, record);
		return { name: ctx.name, phase: record.phase, origin: record.origin };
	}
	mkdirSync(ctx.folder, { recursive: true, mode: 0o700 });
	canonical(ctx.folder);
	const result = await withLock(ctx.file, async () => {
		let record = load();
		if (!record) {
			// Never infer ownership from a branch name or adopt preexisting env/data.
			const legacy = join(ctx.gitDir, "wt-dev.json");
			const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], ctx.dir);
			const oldFile = join(ctx.folder, `${branch}.json`);
			if (
				present(legacy) ||
				(relative(ctx.folder, oldFile).startsWith("..")
					? false
					: present(oldFile))
			)
				throw new Error(
					"legacy ownership record retained; inspect manually before setup or cleanup",
				);
			if (present(ctx.directory) || present(ctx.envPath))
				throw new Error(
					"runtime resources exist with unknown ownership; nothing adopted or deleted",
				);
			if (["stop", "teardown"].includes(command))
				return { name: ctx.name, phase: "absent" };
			if (command === "dev") throw new Error("run setup first");
			record = newRecord(ctx);
			save(ctx, record);
		}
		if (["setup", "resume"].includes(command))
			return prepare(ctx, record, execute);
		assertRuntime(ctx, record);
		if (command === "dev") return dev(ctx, record);
		if (command === "teardown") await config.beforeTeardown?.(ctx, record);
		await stopResources(ctx, record);
		if (command === "stop") return { name: ctx.name, phase: record.phase };
		record.phase = "tearing-down";
		save(ctx, record);
		// Recheck after adapter callbacks and process shutdown, before deleting files.
		assertRuntime(ctx, record);
		if (present(ctx.envPath)) rmSync(ctx.envPath);
		if (present(ctx.directory)) rmSync(ctx.directory, { recursive: true });
		await config.afterTeardown?.(ctx, record);
		rmSync(ctx.file);
		return { name: ctx.name, phase: "removed" };
	});
	if (!result?.finished) return result;
	// The dev server runs in the foreground; the lock is released meanwhile so
	// stop/check work from another terminal. Clear only this server's record.
	const exitCode = await result.finished;
	await withLock(ctx.file, async () => {
		const record = load();
		if (record?.process?.pid === result.pid) await stopResources(ctx, record);
	});
	return { name: ctx.name, phase: "stopped", origin: result.origin, exitCode };
}

export async function runLifecycleCli(config) {
	const [command, ...flags] = process.argv.slice(2);
	if (
		flags.some((flag) => flag !== "--main") ||
		flags.length > 1 ||
		!["setup", "resume", "stop", "teardown", "check", "dev"].includes(command)
	)
		throw new Error(
			"usage: node scripts/runtime.mjs setup|resume|stop|teardown|check|dev [--main]",
		);
	const result = await runLifecycle(config, command, {
		allowMain: flags.includes("--main"),
	});
	if (result?.exitCode) process.exitCode = result.exitCode;
	// Never print environment, captured payloads, or adapter fields.
	console.log(
		JSON.stringify({
			name: result?.name,
			phase: result?.phase,
			origin: result?.origin,
		}),
	);
}

/** Inspect all records without adopting, stopping, deleting, or repairing anything. */
export async function auditResources(
	config,
	cwd = process.cwd(),
	adapters = {},
) {
	const ctx = context(config, cwd);
	const issues = [],
		notes = [],
		owned = new Set();
	if (!present(ctx.folder)) return { issues, notes };
	canonical(ctx.folder);
	for (const file of readdirSync(ctx.folder).filter((name) =>
		name.endsWith(".json"),
	)) {
		try {
			const path = join(ctx.folder, file);
			canonical(path);
			const record = readJson(path);
			if (record.version !== MANIFEST_VERSION) {
				notes.push(
					`${file}: legacy or unknown ownership record retained; manual inspection required`,
				);
				continue;
			}
			const owner = context(config, record.worktree);
			if (owner.common !== ctx.common || owner.file !== path)
				throw new Error("manifest Git binding differs");
			validateRecord(owner, record);
			binding(owner);
			owned.add(basename(owner.directory));
			assertRuntime(owner, record);
			if (record.process)
				verifyGroup(record.process, (adapters.processes ?? processes)());
			if (record.appGroup)
				verifyGroup(record.appGroup, (adapters.processes ?? processes)());
			if (["ready", "stopped", "running"].includes(record.phase)) {
				assertReady(owner, record);
				await config.checkReady?.(owner, record);
				notes.push(`${record.name}: owned ${record.phase}`);
			} else
				issues.push(
					`${record.name}: incomplete ${record.phase}; inspect before retrying resume or teardown in its owning checkout`,
				);
		} catch (error) {
			issues.push(`${file}: ${error.message}; resources retained`);
		}
	}
	for (const name of readdirSync(ctx.folder).filter(
		(name) => name.startsWith("data-") && !owned.has(name),
	))
		notes.push(`${name}: unknown ownership; no automatic deletion`);
	return { issues, notes };
}

// Retained pure checks for callers inspecting historical database ownership.
export const databaseMatches = (name, prefix) =>
	name === prefix || name.startsWith(`${prefix}_`);
export function assertIdentity(actual, expected) {
	if (!expected || JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(
			"database server identity changed or unavailable; refusing database cleanup",
		);
}
