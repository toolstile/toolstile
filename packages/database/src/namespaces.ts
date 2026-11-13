/** Room left after the base for a numeric suffix, within a short namespace. */
const BASE_LENGTH = 20;

/**
 * The readable base for a source's label: lowercase ASCII letters, digits and single
 * underscores, starting with a letter and never ending with `_`, so `<namespace>__<tool>`
 * splits unambiguously.
 */
export function namespaceBase(label: string) {
	const slug = label
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^[^a-z]+/, "")
		.slice(0, BASE_LENGTH)
		.replace(/_+$/, "");
	return slug || "server";
}

/** `linear`, then `linear2`, `linear3`; a base ending in a digit takes `_2` so `s3` never becomes `s32`. */
export function nextNamespace(label: string, taken: ReadonlySet<string>) {
	const base = namespaceBase(label);
	if (!taken.has(base)) return base;
	const separator = /\d$/.test(base) ? "_" : "";
	for (let n = 2; ; n++) {
		const candidate = `${base}${separator}${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Any pool, client or transaction; `$n` placeholders. */
type Executor = {
	query(
		sql: string,
		params?: unknown[],
	): Promise<{ rows: Record<string, unknown>[] }>;
};
export interface NamespaceSource {
	id: string;
	label: string;
}

/**
 * Each source's namespace within a scope, allocating any that are missing in the given
 * order. Allocations are never deleted or reassigned, so a name a client has seen can
 * never route to a different source, even after its source is removed.
 */
export async function allocateNamespaces(
	executor: Executor,
	scopeId: string,
	sources: readonly NamespaceSource[],
): Promise<Map<string, string>> {
	const load = async () => {
		const { rows } = await executor.query(
			'SELECT "sourceId", namespace FROM source_namespaces WHERE "scopeId"=$1',
			[scopeId],
		);
		return rows as { sourceId: string; namespace: string }[];
	};
	let rows = await load();
	const byId = new Map(rows.map((row) => [row.sourceId, row.namespace]));
	for (const source of sources) {
		while (!byId.has(source.id)) {
			const namespace = nextNamespace(
				source.label,
				new Set(rows.map((row) => row.namespace)),
			);
			// A concurrent allocation of the name or of this source inserts nothing; reload
			// and either adopt the source's allocation or try the next free name.
			const inserted = await executor.query(
				`INSERT INTO source_namespaces ("scopeId", namespace, "sourceId")
					VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING namespace`,
				[scopeId, namespace, source.id],
			);
			if (inserted.rows.length) {
				byId.set(source.id, namespace);
				rows.push({ sourceId: source.id, namespace });
				continue;
			}
			rows = await load();
			for (const row of rows) byId.set(row.sourceId, row.namespace);
		}
	}
	return byId;
}
