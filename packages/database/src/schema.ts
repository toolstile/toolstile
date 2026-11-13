import { sql } from "drizzle-orm";
import { browserDeviceColumns } from "./columns";
import type { ConnectionStatus } from "./connection-status";
import {
	boolean,
	check,
	dateTime,
	index,
	integer,
	json,
	pgTable,
	primaryKey,
	text,
} from "./pg-columns";
export const user = pgTable(
	"user",
	{
		id: text().primaryKey(),
		name: text().notNull(),
		email: text().notNull().unique(),
		emailVerified: boolean().notNull().default(false),
		image: text(),
		createdAt: dateTime().notNull().default(sql`now()`),
		updatedAt: dateTime().notNull().default(sql`now()`),
	},
	(t) => [index("user_email_lower").on(sql`lower(${t.email})`)],
);
export const session = pgTable(
	"session",
	{
		id: text().primaryKey(),
		token: text().notNull().unique(),
		expiresAt: dateTime().notNull(),
		createdAt: dateTime().notNull().default(sql`now()`),
		updatedAt: dateTime().notNull().default(sql`now()`),
		ipAddress: text(),
		userAgent: text(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(t) => [
		index("session_expiry").on(t.expiresAt),
		index("session_user").on(t.userId),
	],
);
export const account = pgTable(
	"account",
	{
		id: text().primaryKey(),
		accountId: text().notNull(),
		providerId: text().notNull(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text(),
		refreshToken: text(),
		idToken: text(),
		accessTokenExpiresAt: dateTime(),
		refreshTokenExpiresAt: dateTime(),
		scope: text(),
		password: text(),
		createdAt: dateTime().notNull().default(sql`now()`),
		updatedAt: dateTime().notNull().default(sql`now()`),
	},
	(t) => [index("account_user").on(t.userId)],
);
export const verification = pgTable("verification", {
	id: text().primaryKey(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: dateTime().notNull(),
	createdAt: dateTime().notNull().default(sql`now()`),
	updatedAt: dateTime().notNull().default(sql`now()`),
});
export const devices = pgTable(
	"devices",
	{
		...browserDeviceColumns(),
		id: text().primaryKey(),
		ownerId: text()
			.notNull()
			.references(() => user.id),
		label: text().notNull(),
		revokedAt: dateTime(),
		createdAt: dateTime().notNull().default(sql`now()`),
	},
	(t) => [index("device_owner").on(t.ownerId)],
);
export const agents = pgTable(
	"agents",
	{
		id: text().primaryKey(),
		ownerId: text()
			.notNull()
			.references(() => user.id),
		deviceId: text()
			.notNull()
			.references(() => devices.id),
		label: text().notNull(),
		createdAt: dateTime().notNull().default(sql`now()`),
	},
	(t) => [
		index("agent_owner").on(t.ownerId),
		index("agent_device").on(t.deviceId),
	],
);
export const connections = pgTable(
	"connections",
	{
		id: text().primaryKey(),
		ownerId: text()
			.notNull()
			.references(() => user.id),
		label: text().notNull(),
		url: text().notNull(),
		transport: text().notNull().default("http"),
		authentication: text().notNull().default("headers"),
		encryptedHeaders: text().notNull(),
		status: text().$type<ConnectionStatus>().notNull().default("configured"),
		connectorId: text(),
		createdAt: dateTime().notNull().default(sql`now()`),
	},
	(t) => [index("connection_owner").on(t.ownerId)],
);
/** Readable namespaces (`linear`, `linear2`) for a scope's sources. Rows outlive their
 * source so a released name is never given to another one (namespaces.ts). */
export const sourceNamespaces = pgTable(
	"source_namespaces",
	{
		scopeId: text().notNull(),
		namespace: text().notNull(),
		sourceId: text().notNull().unique(),
		createdAt: dateTime().notNull().default(sql`now()`),
	},
	(t) => [primaryKey({ columns: [t.scopeId, t.namespace] })],
);
export const connectorRequests = pgTable(
	"connector_requests",
	{
		ownerId: text("owner_id").notNull(),
		scopeId: text("scope_id").notNull(),
		requestId: text("request_id").notNull(),
		fingerprint: text().notNull(),
		response: json().notNull(),
		createdAt: dateTime("created_at").notNull().default(sql`now()`),
	},
	(table) => [
		primaryKey({ columns: [table.ownerId, table.scopeId, table.requestId] }),
		index("connector_requests_created_at").on(table.createdAt),
	],
);
export const upstreamOAuthGrants = pgTable("upstream_oauth_grants", {
	leaseId: text(),
	leaseUntil: dateTime(),
	refreshPending: boolean().notNull().default(false),
	id: text().primaryKey(),
	encryptedData: text().notNull(),
	updatedAt: dateTime().notNull().default(sql`now()`),
});
export const connectionOAuth = pgTable("connection_oauth", {
	connectionId: text()
		.primaryKey()
		.references(() => connections.id, { onDelete: "cascade" }),
	grantId: text()
		.notNull()
		.references(() => upstreamOAuthGrants.id),
});
export const upstreamOAuthFlows = pgTable("upstream_oauth_flows", {
	id: text().primaryKey(),
	connectionId: text()
		.notNull()
		.references(() => connections.id, { onDelete: "cascade" }),
	userId: text()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	sessionId: text()
		.notNull()
		.references(() => session.id, { onDelete: "cascade" }),
	serverUrl: text().notNull(),
	encryptedData: text().notNull(),
	expiresAt: dateTime().notNull(),
	consumedAt: dateTime(),
});
// Schema for the pinned Better Auth 1.7.11 MCP and JWT plugins.
export const oauthClient = pgTable("oauthClient", {
	id: text().primaryKey(),
	clientId: text().notNull().unique(),
	clientSecret: text(),
	clientDiscoveryId: text(),
	disabled: boolean().default(false),
	skipConsent: boolean(),
	enableEndSession: boolean(),
	subjectType: text(),
	scopes: json().$type<string[]>(),
	clientCredentialsScopes: json().$type<string[]>().default([]),
	userId: text().references(() => user.id),
	createdAt: dateTime(),
	updatedAt: dateTime(),
	name: text(),
	uri: text(),
	icon: text(),
	contacts: json().$type<string[]>(),
	tos: text(),
	policy: text(),
	softwareId: text(),
	softwareVersion: text(),
	softwareStatement: text(),
	redirectUris: json().$type<string[]>().notNull(),
	postLogoutRedirectUris: json().$type<string[]>(),
	backchannelLogoutUri: text(),
	backchannelLogoutSessionRequired: boolean(),
	tokenEndpointAuthMethod: text(),
	applicationType: text(),
	jwks: text(),
	jwksUri: text(),
	grantTypes: json().$type<string[]>(),
	responseTypes: json().$type<string[]>(),
	requirePKCE: boolean(),
	dpopBoundAccessTokens: boolean().default(false),
	referenceId: text(),
	metadata: json(),
});
export const oauthResource = pgTable("oauthResource", {
	id: text().primaryKey(),
	identifier: text().notNull().unique(),
	name: text().notNull(),
	accessTokenTtl: integer(),
	refreshTokenTtl: integer(),
	signingAlgorithm: text(),
	signingKeyId: text(),
	allowedScopes: json().$type<string[]>(),
	customClaims: json(),
	dpopBoundAccessTokensRequired: boolean().default(false),
	disabled: boolean().default(false),
	createdAt: dateTime(),
	updatedAt: dateTime(),
	policyVersion: integer().default(1),
	metadata: json(),
});
export const oauthClientResource = pgTable("oauthClientResource", {
	id: text().primaryKey(),
	clientId: text()
		.notNull()
		.references(() => oauthClient.clientId, { onDelete: "cascade" }),
	resourceId: text()
		.notNull()
		.references(() => oauthResource.identifier, { onDelete: "cascade" }),
	metadata: json(),
	createdAt: dateTime(),
});
export const oauthRefreshToken = pgTable("oauthRefreshToken", {
	id: text().primaryKey(),
	token: text().notNull().unique(),
	clientId: text()
		.notNull()
		.references(() => oauthClient.clientId),
	sessionId: text().references(() => session.id, { onDelete: "set null" }),
	userId: text()
		.notNull()
		.references(() => user.id),
	referenceId: text(),
	authorizationCodeId: text(),
	resources: json().$type<string[]>(),
	requestedUserInfoClaims: json().$type<string[]>(),
	expiresAt: dateTime().notNull(),
	createdAt: dateTime().notNull(),
	revoked: dateTime(),
	rotatedAt: dateTime(),
	rotationReplayResponse: text(),
	rotationReplayExpiresAt: dateTime(),
	authTime: dateTime(),
	confirmation: json(),
	scopes: json().$type<string[]>().notNull(),
});
export const oauthAccessToken = pgTable("oauthAccessToken", {
	id: text().primaryKey(),
	token: text().notNull().unique(),
	clientId: text()
		.notNull()
		.references(() => oauthClient.clientId),
	sessionId: text().references(() => session.id, { onDelete: "set null" }),
	userId: text().references(() => user.id),
	referenceId: text(),
	authorizationCodeId: text(),
	resources: json().$type<string[]>(),
	requestedUserInfoClaims: json().$type<string[]>(),
	refreshId: text().references(() => oauthRefreshToken.id),
	expiresAt: dateTime().notNull(),
	createdAt: dateTime().notNull(),
	revoked: dateTime(),
	confirmation: json(),
	scopes: json().$type<string[]>().notNull(),
});
export const oauthConsent = pgTable("oauthConsent", {
	id: text().primaryKey(),
	clientId: text()
		.notNull()
		.references(() => oauthClient.clientId),
	userId: text().references(() => user.id),
	referenceId: text(),
	resources: json().$type<string[]>(),
	requestedUserInfoClaims: json().$type<string[]>(),
	scopes: json().$type<string[]>().notNull(),
	createdAt: dateTime().notNull(),
	updatedAt: dateTime().notNull(),
});
export const oauthClientAssertion = pgTable("oauthClientAssertion", {
	id: text().primaryKey(),
	expiresAt: dateTime().notNull(),
});
export const jwks = pgTable("jwks", {
	id: text().primaryKey(),
	publicKey: text().notNull(),
	privateKey: text().notNull(),
	createdAt: dateTime().notNull(),
	expiresAt: dateTime(),
	alg: text(),
	crv: text(),
});
export const oauthFlowSelection = pgTable("oauth_flow_selection", {
	id: text().primaryKey(),
	sessionId: text()
		.notNull()
		.references(() => session.id, { onDelete: "cascade" }),
	userId: text()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	referenceId: text().notNull(),
	expiresAt: dateTime().notNull(),
});
export const oauthSchema = {
	oauthClient,
	oauthResource,
	oauthClientResource,
	oauthRefreshToken,
	oauthAccessToken,
	oauthConsent,
	oauthClientAssertion,
	jwks,
};
export const authSchema = {
	user,
	session,
	account,
	verification,
	...oauthSchema,
};
export const baseSchema = {
	...authSchema,
	devices,
	agents,
	connections,
	connectionOAuth,
	upstreamOAuthGrants,
	upstreamOAuthFlows,
	oauthFlowSelection,
};
/** Ephemeral assertion rows exist only inside an atomic batch and are removed in it. */
export const atomicPlanGuard = pgTable(
	"_atomic_plan_guard",
	{
		id: text().primaryKey(),
		valid: integer().notNull(),
	},
	(table) => [check("atomic_plan_valid", sql`${table.valid} = 1`)],
);

/** Primary relational directory and admission counters for independently owned
 * Worker sessions. Payloads, bearer tokens and upstream credentials never enter it. */
export const mcpOwners = pgTable(
	"mcp_owners",
	{
		id: text().primaryKey(),
		keyHash: text().notNull(),
		ownerHash: text().notNull(),
		expiresAt: dateTime().notNull(),
	},
	(table) => [
		index("mcp_owner_agent").on(table.keyHash, table.expiresAt),
		index("mcp_owner_user").on(table.ownerHash, table.expiresAt),
		index("mcp_owner_expiry").on(table.expiresAt),
	],
);
export const mcpOwnerRates = pgTable("mcp_owner_rates", {
	keyHash: text().primaryKey(),
	count: integer().notNull(),
	resetsAt: dateTime().notNull(),
});
