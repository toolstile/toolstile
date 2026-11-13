// Pure policy: no environment mutation, network calls or provider configuration.
const developmentKeys = [
	"DATABASE_URL",
	"BETTER_AUTH_URL",
	"BETTER_AUTH_SECRET",
	"ENCRYPTION_KEY",
];
const runtimeKeys = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"TERM",
	"COLORTERM",
	"CI",
	"FNM_MULTISHELL_PATH",
	"FNM_DIR",
	"PNPM_HOME",
];
export function runtimeEnvironment(source = process.env) {
	return Object.fromEntries(
		runtimeKeys
			.filter((key) => source[key] !== undefined)
			.map((key) => [key, source[key]]),
	);
}
export function localOrigin(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("invalid local app origin");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		!(isLoopback(url.hostname) || /\.(localhost|local)$/.test(url.hostname))
	)
		throw new Error("app origin must be local (loopback, *.localhost or *.local)");
	return url;
}
const isLoopback = (host) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
export function localDatabase(
	value,
	{ databaseNames = ["toolstile"], databaseHosts = ["postgres"] } = {},
) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("invalid local database target");
	}
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!(isLoopback(url.hostname) || databaseHosts.includes(url.hostname)) ||
		url.search ||
		url.hash ||
		!databaseNames.includes(decodeURIComponent(url.pathname.slice(1)))
	)
		throw new Error("database must be a recognized local disposable target");
	return url;
}
export function isolatedWorktreeEnvironment(
	source,
	{ name, database, origin, allowKeys = [], defaults = {} },
) {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name))
		throw new Error("invalid worktree name");
	const env = Object.fromEntries(
		[...developmentKeys, ...allowKeys]
			.filter((key) => !key.startsWith("TEST_") && source[key] !== undefined)
			.map((key) => [key, source[key]]),
	);
	if(!database.startsWith("/"))localDatabase(database, {
		databaseNames: [decodeURIComponent(new URL(database).pathname.slice(1))],
	});
	env.DATABASE_URL = database;
	env.BETTER_AUTH_URL = localOrigin(origin).origin;
	return { ...env, TOOLSTILE_CATALOG_FETCH: "off", ...defaults };
}
export function serializeEnvironment(env) {
	return `${Object.entries(env)
		.map(([key, value]) => {
			if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(String(value)))
				throw new Error("unsafe environment assignment");
			// Node dotenv supports quoted values, including embedded double quotes in single quotes.
			if (String(value).includes("'"))
				throw new Error(`unsupported quote in ${key}`);
			return `${key}='${value}'`;
		})
		.join("\n")}\n`;
}
export function localTestEnvironment(file, inherited = {}, options = {}) {
	const app = localOrigin(file.BETTER_AUTH_URL);
	const database = localDatabase(file.DATABASE_URL, options);
	const extraTargets = {};
	for (const [source, target] of Object.entries(options.originTargets ?? {})) {
		const origin = file[source] ? localOrigin(file[source]).origin : app.origin;
		extraTargets[source] = origin;
		extraTargets[target] = origin;
	}
	// Reject stale shell or file overrides; never silently reinterpret an operator's target.
	const targets = {
		DATABASE_URL: database.href,
		BETTER_AUTH_URL: app.origin,
		TEST_DATABASE_URL: database.href,
		TEST_BASE_URL: app.origin,
		...extraTargets,
	};
	for (const source of [file, inherited])
		for (const [key, expected] of Object.entries(targets)) {
			if (source[key] && source[key] !== expected)
				throw new Error(
					`conflicting ${key}; clear the override before local tests`,
				);
		}
	const env = {
		...runtimeEnvironment(inherited),
		...Object.fromEntries(
			[...developmentKeys, ...(options.allowKeys ?? [])]
				.filter((key) => file[key] !== undefined)
				.map((key) => [key, file[key]]),
		),
		...options.defaults,
	};
	for (const key of Object.keys(env))
		if (key.startsWith("TEST_")) delete env[key];
	return { ...env, ...targets };
}
export function assertTestOwnership(
	record,
	{ root, main, name, file, originKeys = [] },
) {
	const db = localDatabase(file.DATABASE_URL, {
		databaseNames: [record.database],
	});
	const app = localOrigin(file.BETTER_AUTH_URL);
	if (
		record.version !== 1 ||
		!record.id ||
		!record.setupComplete ||
		record.worktree !== root ||
		record.main !== main ||
		record.name !== name ||
		!record.database ||
		decodeURIComponent(db.pathname.slice(1)) !== record.database ||
		db.hostname !== record.server?.host ||
		(db.port || "5432") !== record.server?.port ||
		!app.hostname.startsWith(`${name}.`) ||
		originKeys.some(
			(key) =>
				file[key] && !localOrigin(file[key]).hostname.startsWith(`${name}.`),
		)
	)
		throw new Error("test target does not match worktree ownership");
}
