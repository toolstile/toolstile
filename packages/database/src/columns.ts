import { sql } from "drizzle-orm";
import { dateTime, integer, json, text } from "./pg-columns";
/** Fresh builders per table; each application owns keys and references. */
export function setupProgressColumns() {
	return {
		status: text().notNull().default("active"),
		step: text().notNull().default("connect"),
		client: text().notNull().default("claude-code"),
		connectionId: text(),
		agentId: text(),
		verificationKey: text(),
		verifiedAt: dateTime(),
		updatedAt: dateTime().notNull().default(sql`now()`),
	};
}
export function authorizationColumns() {
	return {
		tokenHash: text().notNull().unique(),
		expiresAt: dateTime(),
		revokedAt: dateTime(),
		createdAt: dateTime().notNull().default(sql`now()`),
	};
}
export function grantColumns<Rules>() {
	return { rules: json().$type<Rules>().notNull() };
}
export function activityColumns() {
	return {
		agent: text().notNull(),
		connection: text().notNull(),
		method: text().notNull(),
		target: text(),
		outcome: text().notNull(),
		durationMs: integer().notNull(),
		createdAt: dateTime().notNull().default(sql`now()`),
	};
}
export function debugSessionColumns() {
	return {
		agentIds: json().$type<string[]>().notNull(),
		connectionIds: json().$type<string[]>().notNull(),
		stopsAt: dateTime().notNull(),
		stoppedAt: dateTime(),
		createdAt: dateTime().notNull().default(sql`now()`),
	};
}
export function debugPayloadColumns() {
	return {
		agentId: text().notNull(),
		connectionId: text().notNull(),
		encryptedPayload: text().notNull(),
		expiresAt: dateTime().notNull(),
		createdAt: dateTime().notNull().default(sql`now()`),
	};
}

export function browserDeviceColumns() {
	return { browserKeyHash: text() };
}

/**
 * Tool-call approval payload and lifecycle. Each host owns `id`, its scope/requester/agent
 * keys and references, and a unique active index over (scopeId, agentId, fingerprint) where
 * status is pending, approved or claimed.
 */
export function approvalColumns() {
	return {
		connectionId: text().notNull(),
		connectionLabel: text().notNull(),
		agentLabel: text().notNull(),
		tool: text().notNull(),
		/** Keyed HMAC of the canonical binding; never a plain argument digest. */
		fingerprint: text().notNull(),
		/** Cleared on every terminal state; metadata remains for history. */
		encryptedRequest: text(),
		status: text().notNull().default("pending"),
		expiresAt: dateTime().notNull(),
		decidedBy: text(),
		decidedAt: dateTime(),
		claimedOperationId: text(),
		claimedAt: dateTime(),
		settledAt: dateTime(),
		createdAt: dateTime().notNull().default(sql`now()`),
	};
}

/**
 * Tool definition review. Each host owns `scopeId` and `connectionId` (its gateway connection
 * id) with their references; see @toolstile/api/tool-review-server for the keys it expects.
 */
export function toolReviewSettingColumns() {
	return {
		enabledBy: text().notNull(),
		enabledAt: dateTime().notNull().default(sql`now()`),
	};
}
export function toolDefinitionColumns() {
	return {
		name: text().notNull(),
		digest: text().notNull(),
		/** Readable canonical JSON, bounded by the gateway; null when too large to keep. */
		snapshot: text(),
		observedAt: dateTime().notNull().default(sql`now()`),
	};
}
export function toolReviewColumns() {
	return {
		name: text().notNull(),
		digest: text().notNull(),
		reviewedBy: text().notNull(),
		reviewedAt: dateTime().notNull().default(sql`now()`),
	};
}
