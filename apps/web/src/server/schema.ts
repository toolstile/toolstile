import {
	activityColumns,
	approvalColumns,
	authorizationColumns,
	debugPayloadColumns,
	debugSessionColumns,
	grantColumns,
	toolDefinitionColumns,
	toolReviewColumns,
	toolReviewSettingColumns,
} from "@toolstile/database";

export * from "@toolstile/database";

import type { Rules } from "@toolstile/api/contract";
import { agents, connections, user } from "@toolstile/database";
import {
	boolean,
	dateTime,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
} from "@toolstile/database/pg-columns";
import { sql } from "drizzle-orm";
export const profiles = pgTable("profiles", {
	userId: text()
		.primaryKey()
		.references(() => user.id),
	operator: boolean().notNull().default(false),
	suspended: boolean().notNull().default(false),
	deletedAt: dateTime(),
	purgeAfter: dateTime(),
});
export const invitations = pgTable("invitations", {
	id: text().primaryKey(),
	// PostgreSQL UNIQUE keeps addressed invites unique and permits multiple NULL email-free invites.
	email: text().unique(),
	expiresAt: dateTime().notNull(),
	createdAt: dateTime()
		.notNull()
		.default(sql`now()`),
});
export const authorizations = pgTable("authorizations", {
	id: text().primaryKey(),
	agentId: text()
		.notNull()
		.unique()
		.references(() => agents.id),
	...authorizationColumns(),
});
export const toolApprovals = pgTable(
	"tool_approvals",
	{
		id: text().primaryKey(),
		scopeId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		requesterId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		agentId: text()
			.notNull()
			.references(() => agents.id, { onDelete: "cascade" }),
		...approvalColumns(),
	},
	(t) => [
		uniqueIndex("tool_approval_active_call")
			.on(t.scopeId, t.agentId, t.fingerprint)
			.where(sql`${t.status} in ('pending','approved','claimed')`),
		index("tool_approval_scope_status").on(t.scopeId, t.status, t.createdAt),
		index("tool_approval_expiry").on(t.expiresAt),
	],
);
export const grants = pgTable(
	"grants",
	{
		id: text().primaryKey(),
		agentId: text()
			.notNull()
			.references(() => agents.id),
		connectionId: text()
			.notNull()
			.references(() => connections.id, { onDelete: "cascade" }),
		...grantColumns<Rules>(),
	},
	(t) => [uniqueIndex("grant_pair").on(t.agentId, t.connectionId)],
);
export const activity = pgTable(
	"activity",
	{
		id: text().primaryKey(),
		ownerId: text()
			.notNull()
			.references(() => user.id),
		...activityColumns(),
	},
	(t) => [
		index("activity_owner_created_at").on(t.ownerId, t.createdAt),
		index("activity_created_at").on(t.createdAt),
		// Setup's first agent tool call for an agent and connection.
		index("activity_first_call")
			.on(t.ownerId, t.agentId, t.connectionId, t.createdAt)
			.where(sql`${t.origin} = 'agent' and ${t.method} = 'tools/call'`),
	],
);
export const allAgentGrants = pgTable(
	"all_agent_grants",
	{
		id: text().primaryKey(),
		ownerId: text()
			.notNull()
			.references(() => user.id),
		connectionId: text()
			.notNull()
			.references(() => connections.id, { onDelete: "cascade" }),
		...grantColumns<Rules>(),
	},
	(t) => [uniqueIndex("all_agent_grant_pair").on(t.ownerId, t.connectionId)],
);
/** Connections whose new and changed tools wait for review. */
export const toolReviewSettings = pgTable("tool_review_settings", {
	connectionId: text()
		.primaryKey()
		.references(() => connections.id, { onDelete: "cascade" }),
	scopeId: text()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	...toolReviewSettingColumns(),
});
export const toolDefinitions = pgTable(
	"tool_definitions",
	{
		id: text().primaryKey(),
		scopeId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		connectionId: text()
			.notNull()
			.references(() => connections.id, { onDelete: "cascade" }),
		...toolDefinitionColumns(),
	},
	(t) => [
		uniqueIndex("tool_definition_version").on(t.connectionId, t.name, t.digest),
	],
);
export const toolReviews = pgTable(
	"tool_reviews",
	{
		scopeId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		connectionId: text()
			.notNull()
			.references(() => connections.id, { onDelete: "cascade" }),
		...toolReviewColumns(),
	},
	(t) => [primaryKey({ columns: [t.connectionId, t.name] })],
);
export const recoveryCodes = pgTable(
	"recovery_codes",
	{
		hash: text().primaryKey(),
		purpose: text().notNull().default("recovery"),
		expiresAt: dateTime(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdAt: dateTime()
			.notNull()
			.default(sql`now()`),
	},
	(t) => [index("recovery_code_user").on(t.userId)],
);
export const accountAudit = pgTable("account_audit", {
	id: text().primaryKey(),
	subjectId: text().notNull(),
	actor: text().notNull(),
	action: text().notNull(),
	reason: text(),
	createdAt: dateTime()
		.notNull()
		.default(sql`now()`),
});
export const instanceSettings = pgTable("instance_settings", {
	id: text().primaryKey(),
	recoveryWindowDays: integer().notNull().default(7),
	registrationPolicy: text().notNull().default("invite-only"),
	allowPrivateNetwork: boolean().notNull().default(true),
	telemetryEnabled: boolean().notNull().default(true),
	activityRetentionDays: integer().notNull().default(30),
	payloadRetentionHours: integer().notNull().default(24),
});
export const accountEmailOutbox = pgTable("account_email_outbox", {
	claimToken: text(),
	claimedUntil: dateTime(),
	id: text().primaryKey(),
	userId: text()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	encryptedMessage: text().notNull(),
	attempts: integer().notNull().default(0),
	availableAt: dateTime()
		.notNull()
		.default(sql`now()`),
	expiresAt: dateTime().notNull(),
});
export const debugSessions = pgTable(
	"debug_sessions",
	{
		id: text().primaryKey(),
		scopeId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		enabledBy: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		...debugSessionColumns(),
	},
	(t) => [index("debug_session_scope").on(t.scopeId)],
);
export const debugPayloads = pgTable(
	"debug_payloads",
	{
		id: text().primaryKey(),
		scopeId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		sessionId: text()
			.notNull()
			.references(() => debugSessions.id, { onDelete: "cascade" }),
		...debugPayloadColumns(),
	},
	(t) => [
		index("debug_payload_session").on(t.sessionId),
		index("debug_payload_expiry").on(t.expiresAt),
	],
);
export { setupProgress } from "./setup-schema";
export { telemetryDaily, telemetryOutbox } from "./telemetry-schema";
