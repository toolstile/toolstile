import { createHash } from "node:crypto";
import type { Rules } from "./index";

/**
 * Deterministic JSON for approval binding. Object keys are sorted; values must be plain JSON.
 * Oversized or deeply nested input is refused rather than truncated so a reviewer always
 * sees the exact parameters that would be forwarded.
 */
export const APPROVAL_MAX_BYTES = 64 * 1024;
export const APPROVAL_MAX_DEPTH = 32;
export class ApprovalUnsupportedError extends Error {}
export function canonicalJson(
	value: unknown,
	limits: { maxBytes?: number; maxDepth?: number } = {},
): string {
	const maxDepth = limits.maxDepth ?? APPROVAL_MAX_DEPTH;
	const maxBytes = limits.maxBytes ?? APPROVAL_MAX_BYTES;
	function walk(item: unknown, depth: number): string {
		if (depth > maxDepth)
			throw new ApprovalUnsupportedError(
				"Tool parameters are nested too deeply to review",
			);
		if (item === null || typeof item === "string" || typeof item === "boolean")
			return JSON.stringify(item);
		if (typeof item === "number") {
			if (!Number.isFinite(item))
				throw new ApprovalUnsupportedError("Tool parameters must be JSON");
			return JSON.stringify(item);
		}
		if (Array.isArray(item))
			return `[${item.map((entry) => walk(entry, depth + 1)).join(",")}]`;
		if (
			typeof item === "object" &&
			[Object.prototype, null].includes(Object.getPrototypeOf(item))
		)
			return `{${Object.entries(item as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(
					([key, entry]) => `${JSON.stringify(key)}:${walk(entry, depth + 1)}`,
				)
				.join(",")}}`;
		throw new ApprovalUnsupportedError("Tool parameters must be JSON");
	}
	const text = walk(value, 0);
	if (Buffer.byteLength(text) > maxBytes)
		throw new ApprovalUnsupportedError(
			"Tool parameters are too large to review",
		);
	return text;
}

export type ToolDecision = "deny" | "approval" | "allow";
/** Block in any source denies; otherwise approval in any source is required; then allow. */
export function toolDecision(rules: Rules[], name: string): ToolDecision {
	if (rules.some((rule) => rule.block.tools.includes(name))) return "deny";
	if (rules.some((rule) => rule.requireApproval?.includes(name)))
		return "approval";
	return rules.some((rule) => rule.full || rule.allow.tools.includes(name))
		? "allow"
		: "deny";
}

/** Exactly the functional parameters forwarded for an approval-gated call. */
export interface ApprovalParameters {
	name: string;
	arguments: Record<string, unknown>;
}
export interface ApprovalRequest {
	connectionId: string;
	connectionLabel: string;
	tool: string;
	parameters: ApprovalParameters;
	/**
	 * Canonical JSON of the connection, selected account/credential identity, rule revision
	 * and parameters. Stores must key this (HMAC) before persisting it.
	 */
	binding: string;
}
export type ApprovalBegin =
	| { kind: "permit"; id: string }
	| {
			kind: "pending" | "denied" | "busy";
			id: string;
			expiresAt: Date;
			reviewUrl?: string;
	  };
export interface RuntimeApprovals {
	/** Claims an approved permit (approved→claimed) or finds/creates the pending request. */
	begin(request: ApprovalRequest, operationId: string): Promise<ApprovalBegin>;
	/**
	 * Known pre-forward refusal (admission/quota): claimed→approved while unexpired and still
	 * bound to the live account and rules; otherwise the claim is invalidated.
	 */
	release(id: string, operationId: string): Promise<void>;
	/**
	 * consumed: about to dispatch; must throw unless this exact operation holds the claim or
	 * already consumed it. invalidated: refused after claim; a no-op otherwise.
	 */
	settle(
		id: string,
		operationId: string,
		outcome: "consumed" | "invalidated",
	): Promise<void>;
}

export class ApprovalRequiredError extends Error {
	constructor(
		readonly approval: {
			id: string;
			status: "pending" | "denied" | "busy";
			expiresAt: Date;
			reviewUrl?: string;
		},
	) {
		super(
			approval.status === "denied"
				? "This exact tool call was denied by a reviewer"
				: approval.status === "busy"
					? "The approved tool call is already running; wait for it to finish"
					: "Approval required before this tool call can run",
		);
	}
}

/** Text shown to the agent; it carries no parameters. */
export function approvalMessage(error: ApprovalRequiredError) {
	const { id, status, expiresAt, reviewUrl } = error.approval;
	if (status === "denied")
		return `Tool call denied by a reviewer (request ${id}). Do not retry this exact call.`;
	if (status === "busy")
		return `Approved request ${id} is already running. Wait for its result instead of retrying.`;
	return [
		`Approval required (request ${id}, expires ${expiresAt.toISOString()}).`,
		"Ask the connection's reviewer to approve this exact call in Toolstile",
		reviewUrl ? `(${reviewUrl}),` : "",
		"then retry the identical call with the same arguments.",
	]
		.filter(Boolean)
		.join(" ");
}

/** Gateway-owned protocol envelope keys the SDK adds to every modern request. */
export function envelopeOnly(meta: unknown, allowed: ReadonlySet<string>) {
	if (meta === undefined) return true;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
	return Object.keys(meta).every((key) => allowed.has(key));
}
/** The gateway's one SHA-256 hex digest helper. */
export const sha256Hex = (text: string) =>
	createHash("sha256").update(text).digest("hex");
