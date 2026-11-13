import { canonicalJson, sha256Hex } from "./approval";

/**
 * Review of upstream tool definitions. When a host attaches a review to an upstream, a tool is
 * listed and callable only while its live definition matches the reviewed digest; new and
 * changed tools wait for a reviewer. Review detects observed metadata changes only: it cannot
 * prove the service behaves as before.
 */
export interface ToolReview {
	/** Reviewed definition digest by upstream tool name. */
	reviewed: ReadonlyMap<string, string>;
	/** Records tools whose live definition is not reviewed. Must not throw for the caller. */
	observe(tools: ObservedTool[]): Promise<void>;
}
/** The definition fields that change what an agent is told or what a call can send. */
export interface ToolDefinition {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	annotations?: unknown;
	icons?: unknown;
	execution?: unknown;
	_meta?: unknown;
}
export interface ObservedTool {
	name: string;
	digest: string;
	/** Readable canonical JSON, or undefined when it is too large to keep. */
	snapshot?: string;
}
/** Kept snapshots are bounded; a larger definition keeps only its digest. */
export const TOOL_SNAPSHOT_MAX_BYTES = 32 * 1024;
const DIGEST_LIMITS = { maxBytes: 4 * 1024 * 1024, maxDepth: 64 };

export function toolDefinition(item: Record<string, unknown>): ToolDefinition {
	const text = (value: unknown) =>
		typeof value === "string" && value.trim() ? value.trim() : undefined;
	const definition: ToolDefinition = { name: String(item.name) };
	const title = text(item.title);
	const description = text(item.description);
	if (title) definition.title = title;
	if (description) definition.description = description;
	// Every field forwarded to agents, so none can change without review.
	for (const field of [
		"inputSchema",
		"outputSchema",
		"annotations",
		"icons",
		"execution",
		"_meta",
	] as const)
		if (item[field] !== undefined && item[field] !== null)
			definition[field] = item[field];
	return definition;
}

/**
 * Digest and readable snapshot of a tool definition. Key order and surrounding whitespace in
 * text are ignored; any other difference is a change. A definition that cannot be represented
 * as JSON gets a digest no review can match, so it stays unreviewed.
 */
export function observeTool(item: Record<string, unknown>): ObservedTool {
	const definition = toolDefinition(item);
	let canonical: string;
	try {
		canonical = canonicalJson(definition, DIGEST_LIMITS);
	} catch {
		return { name: definition.name, digest: "unrepresentable" };
	}
	const snapshot = JSON.stringify(JSON.parse(canonical), null, 2);
	return {
		name: definition.name,
		digest: sha256Hex(canonical),
		...(Buffer.byteLength(snapshot) <= TOOL_SNAPSHOT_MAX_BYTES
			? { snapshot }
			: {}),
	};
}

export const toolReviewed = (review: ToolReview, observed: ObservedTool) =>
	observed.digest !== "unrepresentable" &&
	review.reviewed.get(observed.name) === observed.digest;
