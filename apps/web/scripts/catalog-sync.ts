import { readFile, writeFile } from "node:fs/promises";
import { parseCatalog } from "@toolstile/api/catalog-source";
import {
	type CatalogEntry,
	type ConnectorInventory,
	connectorInventory,
} from "@toolstile/api/connectors";
import {
	emptyRules,
	inspect,
	type Runtime,
	type Upstream,
	validateHttpDestination,
} from "@toolstile/gateway";
import { snapshotFile } from "./catalog-v1";

type RawDocument = {
	version: 1;
	generatedAt: string;
	entries: (Record<string, unknown> & { slug: string })[];
};

/** The bundled v1 snapshot exactly as written, so unrelated entries keep their keys and values. */
export async function readCatalogFile(file: URL = snapshotFile) {
	const raw = JSON.parse(await readFile(file, "utf8")) as RawDocument;
	const parsed = parseCatalog(raw);
	if (!parsed || parsed.dropped)
		throw new Error("The bundled snapshot does not validate as a v1 catalog");
	return { raw, entries: parsed.entries };
}
/** Validates the whole snapshot before writing; a failed check leaves the file as it was. */
export async function writeCatalogFile(
	document: RawDocument,
	file: URL = snapshotFile,
) {
	const parsed = parseCatalog(document);
	if (
		!parsed ||
		parsed.dropped ||
		parsed.entries.length !== document.entries.length
	)
		throw new Error("The snapshot does not validate as a v1 catalog");
	await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
}
/** Replaces tool snapshots by slug; `generatedAt` follows the newest observation. */
export function applyInventories(
	document: RawDocument,
	updates: Map<string, ConnectorInventory>,
): RawDocument {
	const entries = document.entries.map((entry) => {
		const toolSnapshot = updates.get(entry.slug);
		return toolSnapshot ? { ...entry, toolSnapshot } : entry;
	});
	const generatedAt = [
		document.generatedAt,
		...[...updates.values()].map((item) => item.observedAt),
	]
		.map((value) => new Date(value).toISOString())
		.sort()
		.at(-1) as string;
	return { ...document, generatedAt, entries };
}
export function inventorySummary(
	before: ConnectorInventory | undefined,
	after: ConnectorInventory,
) {
	const names = (inventory?: ConnectorInventory) =>
		new Set(inventory?.tools.map((tool) => tool.name) ?? []);
	const previous = names(before),
		next = names(after);
	const added = [...next].filter((name) => !previous.has(name));
	const removed = [...previous].filter((name) => !next.has(name));
	const counts = `${after.tools.length} tools, ${after.resources.length} resources, ${after.prompts.length} prompts`;
	if (!before) return `${counts} (new)`;
	const detail = [
		...added.slice(0, 5).map((name) => `+${name}`),
		...removed.slice(0, 5).map((name) => `-${name}`),
	].join(", ");
	return `${counts} (tools +${added.length} -${removed.length}${detail ? `: ${detail}` : ""})`;
}

/** `CATALOG_DISCOVER_TOKEN_<SLUG>`, with the slug upper-cased and hyphens as underscores. */
export const discoveryTokenVariable = (slug: string) =>
	`CATALOG_DISCOVER_TOKEN_${slug.toUpperCase().replaceAll("-", "_")}`;
export type DiscoveryPlan =
	| { entry: CatalogEntry; headers: Record<string, string> }
	| { entry: CatalogEntry; skip: string };
export function discoveryPlan(
	entry: CatalogEntry,
	environment: Record<string, string | undefined>,
): DiscoveryPlan {
	if (entry.fields.some((field) => field.required))
		return { entry, skip: "needs configuration" };
	const token = environment[discoveryTokenVariable(entry.slug)];
	if (token && entry.authMethods.includes("bearer"))
		return { entry, headers: { Authorization: `Bearer ${token}` } };
	if (entry.authMethods.includes("none")) return { entry, headers: {} };
	return { entry, skip: "needs sign-in" };
}

/**
 * Lists one entry's endpoint with the gateway's own client and catalog reader. Only list
 * requests are sent, and the result is returned only when all of it validates.
 */
export async function discoverInventory(
	entry: CatalogEntry,
	headers: Record<string, string>,
	options: {
		timeoutMs?: number;
		validateDestination?: (url: URL) => Promise<void>;
		now?: () => Date;
	} = {},
): Promise<ConnectorInventory> {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 20_000);
	const upstream: Upstream = {
		id: entry.slug,
		label: entry.name,
		url: entry.endpoint,
		transport: "http",
		headers,
		rules: [{ ...emptyRules(), full: true }],
	};
	const runtime: Runtime = {
		connections: async () => [upstream],
		admit: async () => {},
		record: async () => {},
		validateDestination: options.validateDestination ?? validateHttpDestination,
		fetch: (input, init) =>
			fetch(input, {
				...init,
				signal: init?.signal
					? AbortSignal.any([init.signal, deadline])
					: deadline,
			}),
	};
	let onAbort = () => {};
	const timeout = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("Timed out listing the server"));
		deadline.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const { inventory } = await Promise.race([
			inspect(runtime, upstream),
			timeout,
		]);
		return connectorInventory.parse({
			observedAt: (options.now?.() ?? new Date()).toISOString(),
			source: "discovery",
			...inventory,
		});
	} finally {
		deadline.removeEventListener("abort", onAbort);
	}
}

/** The message plus the underlying network reason or cause, on one line. */
function failure(error: unknown) {
	const parts: string[] = [];
	let current = error;
	for (let depth = 0; depth < 4 && current; depth++) {
		const message =
			current instanceof Error ? current.message : String(current);
		if (message && !parts.includes(message)) parts.push(message);
		const reason =
			current instanceof Error && "reason" in current
				? String(current.reason)
				: "";
		if (reason && !parts.includes(reason)) parts.push(reason);
		current = current instanceof Error ? current.cause : undefined;
	}
	return parts.join(" | ").replace(/\s+/g, " ").slice(0, 300);
}
/** Bounded concurrency; each entry succeeds or fails on its own. */
export async function discoverAll(
	plans: Extract<DiscoveryPlan, { headers: Record<string, string> }>[],
	options: Parameters<typeof discoverInventory>[2] & { concurrency?: number },
) {
	const results: (
		| { id: string; inventory: ConnectorInventory }
		| { id: string; error: string }
	)[] = [];
	const queue = [...plans];
	await Promise.all(
		Array.from({ length: options.concurrency ?? 6 }, async () => {
			for (let plan = queue.shift(); plan; plan = queue.shift()) {
				try {
					results.push({
						id: plan.entry.slug,
						inventory: await discoverInventory(
							plan.entry,
							plan.headers,
							options,
						),
					});
				} catch (error) {
					results.push({
						id: plan.entry.slug,
						error: failure(error),
					});
				}
			}
		}),
	);
	return results.sort((a, b) => a.id.localeCompare(b.id));
}
