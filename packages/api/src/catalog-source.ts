import { createHash } from "node:crypto";
import { createDestinationPolicy } from "@toolstile/gateway";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import {
	type CatalogEntry,
	type CatalogLogoType,
	catalogEntry,
	connectorLogoProblem,
} from "./connectors.js";

export {
	type CatalogEntry,
	type CatalogLogoType,
	catalogEntry,
	catalogField,
	catalogIdentifier,
	catalogLogoTypes,
	matchCatalogEntry,
} from "./connectors.js";

export const defaultCatalogUrl = "https://www.toolstile.com/catalog/v1.json";
const userAgent = `Toolstile/${packageJson.version}`;
const jsonLimit = 1024 * 1024;
const logoLimit = 256 * 1024;
/** Total budget per request, connection and body included; also the cold-start wait. */
const requestBudget = 10_000;
const logoConcurrency = 4;
/** Logos held in memory at once; a catalog references at most one each. */
const logoCacheLimit = 2_000;

const catalogDocument = z.object({
	version: z.literal(1),
	generatedAt: z.iso.datetime({ offset: true }),
	entries: z.array(z.unknown()).max(1000),
});
export type CatalogDocument = {
	version: 1;
	generatedAt: string;
	entries: CatalogEntry[];
};

/** The published v1 feed contains only listed entries and uses null for unknown inventories.
 * Keep the wire compatibility at this boundary; internal entries retain explicit visibility. */
const publishedEntry = catalogEntry.extend({
	listed: z.boolean().default(true),
	toolSnapshot: catalogEntry.shape.toolSnapshot
		.nullish()
		.transform((value) => value ?? undefined),
});

/** Valid listed entries of a v1 document, or undefined when the document itself is invalid. */
export function parseCatalog(input: unknown) {
	const document = catalogDocument.safeParse(input);
	if (!document.success) return;
	const seen = new Set<string>();
	let dropped = 0;
	const entries = document.data.entries.flatMap((raw) => {
		const parsed = publishedEntry.safeParse(raw);
		if (!parsed.success || seen.has(parsed.data.slug)) {
			dropped++;
			return [];
		}
		seen.add(parsed.data.slug);
		return parsed.data.listed ? [parsed.data] : [];
	});
	return { generatedAt: document.data.generatedAt, entries, dropped };
}

const signatures: Record<
	Exclude<CatalogLogoType, "svg">,
	(b: Uint8Array) => boolean
> = {
	png: (b) =>
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
			(byte, index) => b[index] === byte,
		),
	webp: (b) =>
		Buffer.from(b.subarray(0, 4)).toString("latin1") === "RIFF" &&
		Buffer.from(b.subarray(8, 12)).toString("latin1") === "WEBP",
};
/** The same artwork checks as catalog data-file logos, applied to the file's bytes. */
export function catalogLogoProblem(type: CatalogLogoType, body: Uint8Array) {
	if (type === "svg") {
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
				body,
			);
		} catch {
			return "SVG logo is not UTF-8";
		}
		return connectorLogoProblem(text);
	}
	if (!signatures[type](body)) return `Logo is not a ${type.toUpperCase()}`;
	return connectorLogoProblem(
		`data:image/${type};base64,${Buffer.from(body).toString("base64")}`,
	);
}
const sha256 = (body: Uint8Array | string) =>
	createHash("sha256").update(body).digest("hex");

/** `/connector-logos/<slug>-<first 16 hex of the file's SHA-256>.<type>`, or null without a logo. */
export function catalogLogoUrl(
	entry: Pick<CatalogEntry, "slug" | "logo"> | undefined,
) {
	return entry?.logo
		? `/connector-logos/${entry.slug}-${entry.logo.sha256.slice(0, 16)}.${entry.logo.type}`
		: null;
}

export type CatalogFetchPolicy = { fetch: typeof fetch };
/** Public HTTPS on port 443 only, DNS checked at connection time, no redirects. */
export function createCatalogFetchPolicy(
	options: Pick<
		Parameters<typeof createDestinationPolicy>[0] & {},
		"resolve"
	> = {},
): CatalogFetchPolicy {
	return createDestinationPolicy({
		protocols: ["https:"],
		ports: [443],
		allowPrivateNetworks: false,
		connectTimeout: 5_000,
		...options,
	});
}
/** `TOOLSTILE_CATALOG_URL` (default www.toolstile.com) and `TOOLSTILE_CATALOG_FETCH=off`. */
export function catalogSettings(env: Record<string, string | undefined>) {
	return {
		url: env.TOOLSTILE_CATALOG_URL?.trim() || defaultCatalogUrl,
		enabled: env.TOOLSTILE_CATALOG_FETCH?.trim().toLowerCase() !== "off",
	};
}
function catalogUrlProblem(value: string) {
	const url = URL.parse(value);
	if (
		url?.protocol !== "https:" ||
		(url.port && url.port !== "443") ||
		url.username ||
		url.password ||
		url.hash
	)
		return "TOOLSTILE_CATALOG_URL must be an https:// URL on port 443 without credentials";
}
/** Logos live next to the catalog on the same origin: `<dir>/v1.json` → `<dir>/v1/logos/<sha>.<type>`. */
export function catalogLogoLocation(
	catalogUrl: string,
	logo: NonNullable<CatalogEntry["logo"]>,
) {
	const base = new URL(catalogUrl);
	base.search = "";
	base.pathname = `${base.pathname.replace(/\.json$/, "")}/logos/`;
	const url = new URL(`${logo.sha256}.${logo.type}`, base);
	if (url.origin !== new URL(catalogUrl).origin)
		throw new Error("Logo is not on the catalog origin");
	return url.href;
}

type Fetched =
	| { status: 304; etag?: undefined; body?: undefined }
	| { status: 200; etag: string | undefined; body: Uint8Array };
/** One guarded request: any status but 200/304 fails (3xx included), and the body is capped while streaming. */
async function fetchCapped(
	policy: CatalogFetchPolicy,
	url: string,
	headers: Record<string, string>,
	limit: number,
	budget: number,
): Promise<Fetched> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("Catalog request timed out")),
		budget,
	);
	try {
		// The deadline runs from before validation and DNS; a fetch that ignores the signal
		// still settles here when it fires, so a refresh can never stay pending.
		const response = await new Promise<Response>((resolve, reject) => {
			let late = false;
			const abort = () => {
				late = true;
				reject(controller.signal.reason);
			};
			controller.signal.addEventListener("abort", abort, { once: true });
			policy
				.fetch(url, {
					headers: { "User-Agent": userAgent, ...headers },
					redirect: "manual",
					signal: controller.signal,
				})
				.then(
					(value) => {
						// Nobody reads a response that arrives after the deadline: release it.
						if (late) void value.body?.cancel().catch(() => {});
						else resolve(value);
					},
					(error) => {
						if (!late) reject(error);
					},
				)
				.finally(() => controller.signal.removeEventListener("abort", abort));
		});
		if (response.status === 304) {
			await response.body?.cancel().catch(() => {});
			return { status: 304 };
		}
		if (response.status !== 200 || !response.body) {
			await response.body?.cancel().catch(() => {});
			throw new Error(`Catalog request returned HTTP ${response.status}`);
		}
		if (Number(response.headers.get("content-length")) > limit) {
			await response.body.cancel().catch(() => {});
			throw new Error("Catalog response is too large");
		}
		const reader = response.body.getReader();
		const stop = () => void reader.cancel().catch(() => {});
		controller.signal.addEventListener("abort", stop);
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (controller.signal.aborted) throw controller.signal.reason;
				if (done) break;
				size += value.byteLength;
				if (size > limit) {
					stop();
					throw new Error("Catalog response is too large");
				}
				chunks.push(value);
			}
		} finally {
			controller.signal.removeEventListener("abort", stop);
		}
		return {
			status: 200,
			etag: response.headers.get("etag") ?? undefined,
			body: Buffer.concat(chunks),
		};
	} finally {
		clearTimeout(timer);
	}
}
async function inBatches<T>(
	items: readonly T[],
	size: number,
	work: (item: T) => Promise<void>,
) {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: Math.min(size, queue.length) }, async () => {
			for (let item = queue.shift(); item; item = queue.shift())
				await work(item);
		}),
	);
}
export type LogoFile = { type: CatalogLogoType; body: Uint8Array };
/** Fetches one logo from the catalog origin; the bytes must match the sha and pass the type checks. */
async function fetchLogo(
	policy: CatalogFetchPolicy,
	catalogUrl: string,
	logo: NonNullable<CatalogEntry["logo"]>,
	budget: number,
): Promise<LogoFile> {
	const response = await fetchCapped(
		policy,
		catalogLogoLocation(catalogUrl, logo),
		{ Accept: "image/*" },
		logoLimit,
		budget,
	);
	if (response.status !== 200) throw new Error("Unexpected logo response");
	return verifiedLogo(logo, response.body);
}
function verifiedLogo(
	logo: NonNullable<CatalogEntry["logo"]>,
	body: Uint8Array,
): LogoFile {
	if (sha256(body) !== logo.sha256)
		throw new Error(`Logo ${logo.sha256} does not match its hash`);
	const problem = catalogLogoProblem(logo.type, body);
	if (problem) throw new Error(`Logo ${logo.sha256}: ${problem}`);
	return { type: logo.type, body };
}
const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * Fetches a v1 catalog and every logo it references (for `catalog:pull`). Fails on an invalid
 * document; entries that are invalid, unlisted or whose logo fails are left out or lose their logo.
 */
export async function pullCatalog(options: {
	url: string;
	fetchPolicy: CatalogFetchPolicy;
}) {
	const problem = catalogUrlProblem(options.url);
	if (problem) throw new Error(problem);
	const response = await fetchCapped(
		options.fetchPolicy,
		options.url,
		{ Accept: "application/json" },
		jsonLimit,
		requestBudget,
	);
	if (response.status !== 200) throw new Error("Unexpected catalog response");
	const parsed = parseCatalog(
		JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
				response.body,
			),
		),
	);
	if (!parsed) throw new Error("The catalog is not a valid v1 document");
	const logos = new Map<string, LogoFile>();
	const problems: string[] = [];
	await inBatches(parsed.entries, logoConcurrency, async (entry) => {
		if (!entry.logo || logos.has(entry.logo.sha256)) return;
		try {
			logos.set(
				entry.logo.sha256,
				await fetchLogo(
					options.fetchPolicy,
					options.url,
					entry.logo,
					requestBudget,
				),
			);
		} catch (error) {
			problems.push(`${entry.slug}: ${message(error)}`);
		}
	});
	const document: CatalogDocument = {
		version: 1,
		generatedAt: parsed.generatedAt,
		entries: parsed.entries.map((entry) =>
			entry.logo && !logos.has(entry.logo.sha256)
				? { ...entry, logo: undefined }
				: entry,
		),
	};
	return { document, logos, dropped: parsed.dropped, problems };
}

export type CatalogSnapshot = {
	catalog: unknown;
	logo(
		sha256: string,
		type: CatalogLogoType,
	): Uint8Array | undefined | Promise<Uint8Array | undefined>;
};
export type CatalogView = {
	origin: "remote" | "snapshot";
	generatedAt: string;
	/** Listed entries; `logo` is present only when its validated file is available. */
	entries: CatalogEntry[];
};
type LoadedLogo = LogoFile & { legacy?: string };
const legacyHash = (value: string) => sha256(value).slice(0, 16);

/**
 * The connector catalog for this process: an in-memory last-good copy of the remote v1
 * catalog, refreshed in the background, with the bundled snapshot as the fallback.
 *
 * - Requests never wait for the network once a copy exists. A cold start waits at most the
 *   request budget (10 s), then serves the snapshot.
 * - One refresh runs at a time. It starts on the first read after `ttlMs` and on a process
 *   timer every `ttlMs` (unref'd; `stop()` clears it). Failures keep the last good copy.
 * - Conditional requests use the last ETag; a 304 renews the copy.
 * - Logos come only from the catalog URL's origin, by SHA-256, verified and type-checked.
 */
export function createCatalogSource(options: {
	url: string;
	enabled: boolean;
	snapshot: () => CatalogSnapshot | Promise<CatalogSnapshot>;
	fetchPolicy: CatalogFetchPolicy;
	ttlMs?: number;
	/** Per-request budget and cold-start wait (default 10 s). */
	budgetMs?: number;
}) {
	const ttl = options.ttlMs ?? 300_000;
	const budget = options.budgetMs ?? requestBudget;
	const problem = catalogUrlProblem(options.url);
	if (problem && options.enabled)
		console.warn(`${problem}; using the bundled connector catalog`);
	const enabled = options.enabled && !problem;
	const logos = new Map<string, LoadedLogo>();
	let snapshot: Promise<{ view: CatalogView; raw: CatalogEntry[] }> | undefined;
	let remote:
		| { view: CatalogView; raw: CatalogEntry[]; etag?: string }
		| undefined;
	let attemptedAt = Number.NEGATIVE_INFINITY;
	let running: Promise<void> | undefined;
	let coldStart: Promise<unknown> | undefined;
	const view = (
		origin: CatalogView["origin"],
		generatedAt: string,
		raw: CatalogEntry[],
	): CatalogView => ({
		origin,
		generatedAt,
		entries: raw.map((entry) =>
			entry.logo && !logos.has(entry.logo.sha256)
				? { ...entry, logo: undefined }
				: entry,
		),
	});
	const store = (sha: string, file: LogoFile) => {
		if (logos.size < logoCacheLimit) logos.set(sha, file);
	};
	function loadSnapshot() {
		snapshot ??= (async () => {
			try {
				const input = await options.snapshot();
				const parsed = parseCatalog(input.catalog);
				if (!parsed)
					throw new Error("Bundled catalog is not a valid v1 document");
				for (const { logo, slug } of parsed.entries) {
					if (!logo || logos.has(logo.sha256)) continue;
					try {
						const body = await input.logo(logo.sha256, logo.type);
						if (!body) throw new Error("missing file");
						store(logo.sha256, verifiedLogo(logo, body));
					} catch (error) {
						console.warn(`Bundled logo for ${slug} skipped: ${message(error)}`);
					}
				}
				return {
					raw: parsed.entries,
					view: view("snapshot", parsed.generatedAt, parsed.entries),
				};
			} catch (error) {
				console.warn(
					`Bundled connector catalog unavailable: ${message(error)}`,
				);
				return {
					raw: [],
					view: {
						origin: "snapshot",
						generatedAt: new Date(0).toISOString(),
						entries: [],
					},
				};
			}
		})();
		return snapshot;
	}
	async function loadLogos(entries: CatalogEntry[]) {
		await inBatches(entries, logoConcurrency, async ({ logo, slug }) => {
			if (!logo || logos.has(logo.sha256)) return;
			try {
				store(
					logo.sha256,
					await fetchLogo(options.fetchPolicy, options.url, logo, budget),
				);
			} catch (error) {
				console.warn(
					`Connector logo for ${slug} unavailable: ${message(error)}`,
				);
			}
		});
	}
	/** Drops logos neither the snapshot nor the current copy references. */
	function prune(keep: CatalogEntry[][]) {
		const used = new Set(
			keep.flat().flatMap((entry) => (entry.logo ? [entry.logo.sha256] : [])),
		);
		for (const sha of logos.keys()) if (!used.has(sha)) logos.delete(sha);
	}
	function refresh(): Promise<void> {
		if (!enabled) return Promise.resolve();
		running ??= (async () => {
			attemptedAt = performance.now();
			try {
				const base = await loadSnapshot();
				const response = await fetchCapped(
					options.fetchPolicy,
					options.url,
					{
						Accept: "application/json",
						...(remote?.etag ? { "If-None-Match": remote.etag } : {}),
					},
					jsonLimit,
					budget,
				);
				let raw: CatalogEntry[], generatedAt: string, etag: string | undefined;
				if (response.status === 304) {
					if (!remote) throw new Error("Unexpected 304 without a cached copy");
					({ raw, etag } = remote);
					generatedAt = remote.view.generatedAt;
				} else {
					const parsed = parseCatalog(
						JSON.parse(
							new TextDecoder("utf-8", {
								fatal: true,
								ignoreBOM: false,
							}).decode(response.body),
						),
					);
					if (!parsed)
						throw new Error("The catalog is not a valid v1 document");
					if (!parsed.entries.length && parsed.dropped)
						throw new Error("The catalog has no valid entries");
					if (parsed.dropped)
						console.warn(
							`Connector catalog: ${parsed.dropped} invalid entries skipped`,
						);
					({ entries: raw, generatedAt } = parsed);
					etag = response.etag;
				}
				await loadLogos(raw);
				remote = { raw, etag, view: view("remote", generatedAt, raw) };
				prune([base.raw, raw]);
			} catch (error) {
				console.warn(`Connector catalog refresh failed: ${message(error)}`);
			} finally {
				running = undefined;
			}
		})();
		return running;
	}
	const timer = enabled
		? setInterval(() => void refresh(), ttl).unref()
		: undefined;
	async function read(): Promise<CatalogView> {
		if (enabled && !remote) {
			coldStart ??= Promise.race([
				refresh(),
				new Promise((resolve) => setTimeout(resolve, budget).unref()),
			]);
			await coldStart;
		}
		if (enabled && performance.now() - attemptedAt >= ttl) void refresh();
		return remote?.view ?? (await loadSnapshot()).view;
	}
	return {
		read,
		/** Waits for one refresh (starting one if none is running). */
		refresh,
		stop() {
			clearInterval(timer);
		},
		/**
		 * The file behind `/connector-logos/<slug>-<hash>.<type>`. The hash is the first 16 hex of
		 * the file's SHA-256, or of the logo string earlier releases hashed (inline SVG markup or a
		 * base64 data URI), so existing URLs keep resolving. Snapshot entries also count.
		 */
		async logoFile(slugValue: string, hash: string, type: string) {
			const current = await read();
			const bundled = (await loadSnapshot()).view;
			for (const entries of [current.entries, bundled.entries]) {
				const logo = entries.find((entry) => entry.slug === slugValue)?.logo;
				const file = logo && logos.get(logo.sha256);
				if (!logo || !file || logo.type !== type) continue;
				if (logo.sha256.startsWith(hash)) return file;
				file.legacy ??= legacyHash(
					file.type === "svg"
						? Buffer.from(file.body).toString("utf8")
						: `data:image/${file.type};base64,${Buffer.from(file.body).toString("base64")}`,
				);
				if (file.legacy === hash) return file;
			}
		},
	};
}
export type CatalogSource = ReturnType<typeof createCatalogSource>;

const sources = new Map<string, WeakMap<CatalogFetchPolicy, CatalogSource>>();
/** One source per process for each catalog URL, fetch setting and fetch policy. */
export function catalogSourceFor(
	options: Parameters<typeof createCatalogSource>[0],
) {
	const key = `${options.enabled ? "on" : "off"} ${options.url}`;
	const byPolicy = sources.get(key) ?? new WeakMap();
	sources.set(key, byPolicy);
	const source =
		byPolicy.get(options.fetchPolicy) ?? createCatalogSource(options);
	byPolicy.set(options.fetchPolicy, source);
	return source;
}
