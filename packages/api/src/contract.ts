import { z } from "zod";
import { approvalReference } from "./approval-contract.js";

export {
	type ConnectionStatus,
	isSignInStatus,
} from "@toolstile/database/connection-status";
export const dashboardDialog = z.enum([
	"connection",
	"agent",
	"upstream-oauth",
	"test-tool",
]);
export type DashboardDialog = z.infer<typeof dashboardDialog>;
export const dashboardSearch = z.object({
	oauth: z.enum(["connected", "failed"]).optional().catch(undefined),
	/** The connection a browser sign-in just completed for; consumed with `oauth`. */
	oauthConnection: z.string().min(1).max(200).optional().catch(undefined),
});
export const capability = z.enum(["tools", "resources", "prompts"]);
/** Access page view: the selected server, capability tab and name filter. */
export const accessSearch = z.object({
	server: z.string().min(1).max(200).optional().catch(undefined),
	capability: capability.optional().catch(undefined),
	query: z.string().max(100).optional().catch(undefined),
	/** The agent (or `everyone`) whose access is open. */
	agent: z.string().min(1).max(200).optional().catch(undefined),
});
export type AccessSearch = z.infer<typeof accessSearch>;
/** Activity page view: the debug capture tab and the outcome filter; `query` and `page` are shared. */
export const activityOutcomeFilter = z.enum([
	"forwarded",
	"denied",
	"errors",
	"approval",
]);
export const activitySearch = z.object({
	tab: z.enum(["debug"]).optional().catch(undefined),
	outcome: activityOutcomeFilter.optional().catch(undefined),
});
export type ActivityOutcomeFilter = z.infer<typeof activityOutcomeFilter>;
// Names people type are shown across the dashboard and in activity.
const controlCharacters = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
export const nameInput = z
	.string()
	.trim()
	.min(1, "Enter a name.")
	.max(100, "Use a name of 100 characters or fewer.")
	.refine(
		(value) => !controlCharacters.test(value),
		"Remove line breaks and other control characters from the name.",
	);
const CAPABILITY_NAME_MAX = 256;
const CAPABILITY_LIST_MAX = 1000;
// Tool, resource and prompt names (or resource URI templates) entered by hand.
const capabilityName = z
	.string()
	.min(1, "Enter a name.")
	.max(CAPABILITY_NAME_MAX, "Use a name of 256 characters or fewer.")
	.refine(
		(value) => value.trim() === value && !controlCharacters.test(value),
		"Remove spaces at the ends, line breaks and other control characters from the name.",
	);
const capabilityNames = z
	.array(capabilityName)
	.max(CAPABILITY_LIST_MAX, "Use at most 1,000 names per list.");
export const rules = z.object({
	full: z.boolean(),
	allow: z.object({
		tools: z.array(z.string()),
		resources: z.array(z.string()),
		prompts: z.array(z.string()),
	}),
	block: z.object({
		tools: z.array(z.string()),
		resources: z.array(z.string()),
		prompts: z.array(z.string()),
	}),
	/** Exact tool names that run only after a person approves the exact call. */
	requireApproval: z.array(z.string().min(1).max(256)).max(1000).optional(),
});
export type Rules = z.infer<typeof rules>;
/** Rules as saved from the dashboard; stored rules are read with `rules` unchanged. */
export const rulesInput = rules.extend({
	allow: z.object({
		tools: capabilityNames,
		resources: capabilityNames,
		prompts: capabilityNames,
	}),
	block: z.object({
		tools: capabilityNames,
		resources: capabilityNames,
		prompts: capabilityNames,
	}),
	requireApproval: capabilityNames.optional(),
});
/** The largest UTF-8 JSON a schema-valid `rulesInput` serializes to: seven name
 * lists at their limits, every UTF-16 unit of a name taking at most six bytes
 * (`JSON.stringify` writes a lone surrogate as a `\uXXXX` escape; other units
 * take three or fewer), plus quotes, commas and fixed keys. */
export const RULES_INPUT_MAX_BYTES =
	7 * CAPABILITY_LIST_MAX * (6 * CAPABILITY_NAME_MAX + 3) + 1024;
export const connectionInput = z.object({
	url: z
		.string()
		.trim()
		.min(1, "Enter the MCP server address.")
		.max(2048, "Use an address of 2,048 characters or fewer.")
		.refine((value) => URL.canParse(value), "This address isn't a valid URL.")
		.refine(
			(value) => /^https?:$/.test(URL.parse(value)?.protocol ?? "http:"),
			"Use an https:// address.",
		),
	label: nameInput.optional(),
	transport: z.enum(["http", "sse", "auto"]).default("auto"),
	authentication: z.enum(["headers", "oauth", "auto"]).default("auto"),
	headers: z.record(z.string(), z.string()).default({}),
});
/** Discovery before the person confirms an address: nothing is saved. */
export const connectionPreviewInput = z
	.object({ url: connectionInput.shape.url })
	.strict();
export const connectionPreviewView = z.object({
	/** The address to confirm; detection may have added a common MCP path. */
	url: z.string(),
	transport: z.enum(["http", "sse"]),
	authentication: z.enum(["headers", "oauth"]),
	status: z.string(),
});
export type ConnectionPreview = z.infer<typeof connectionPreviewView>;
/**
 * Creates a connection at exactly the confirmed URL, for a catalog suggestion and a typed
 * address alike. `suggestionId` is a display hint only and is not part of the request
 * fingerprint; the label is display text too.
 */
export const connectConnectorInput = z
	.object({
		requestId: z.uuid(),
		url: connectionInput.shape.url,
		authentication: z.enum(["headers", "oauth"]),
		/** The person's override or the previewed transport; omitted, the exact URL is tried with each. */
		transport: z.enum(["http", "sse"]).optional(),
		headers: z.record(z.string(), z.string().max(4096)).default({}),
		label: nameInput.optional(),
		suggestionId: z
			.string()
			.regex(/^[a-z][a-z0-9-]{0,63}$/)
			.optional(),
	})
	.strict();
export type ConnectConnectorInput = z.infer<typeof connectConnectorInput>;
export const connectionView = z.object({
	id: z.string(),
	label: z.string(),
	url: z.string(),
	transport: z.string(),
	status: z.string(),
	authentication: z.enum(["headers", "oauth"]).default("headers"),
	canManageAuthentication: z.boolean().default(true),
	/** False when this person may not check the server's tools (discovery); absent means allowed. */
	canCheckTools: z.boolean().optional(),
	connectorId: z.string().nullable().optional(),
	/** The matching catalog entry's content-addressed logo URL, when there is one. */
	logoUrl: z.string().nullable().optional(),
});
export const upstreamOAuthInput = z
	.object({
		id: z.string(),
		clientId: z.string().trim().max(1024).optional(),
		clientSecret: z.string().max(4096).optional(),
		confirmAccountReplacement: z.boolean().default(false),
	})
	.refine((value) => !value.clientSecret || !!value.clientId, {
		message: "A client ID is required with a client secret",
	});
export const deviceView = z.object({
	id: z.string(),
	label: z.string(),
	revoked: z.boolean(),
});
export const agentView = z.object({
	canTest: z.boolean().default(true),
	id: z.string(),
	label: z.string(),
	deviceId: z.string(),
	revoked: z.boolean(),
	expiresAt: z.string().nullable(),
});
export const grantView = z.object({
	agentId: z.string(),
	connectionId: z.string(),
	rules,
});
export const activityView = z.object({
	id: z.string(),
	agent: z.string(),
	connection: z.string(),
	method: z.string(),
	target: z.string().nullable(),
	outcome: z.string(),
	durationMs: z.number(),
	createdAt: z.string(),
});
export const snapshotView = z.object({
	user: z.object({
		name: z.string(),
		email: z.string(),
		operator: z.boolean(),
	}),
	connections: z.array(connectionView),
	devices: z.array(deviceView),
	agents: z.array(agentView),
	grants: z.array(grantView),
	activity: z.array(activityView),
	allAgentGrants: z
		.array(z.object({ connectionId: z.string(), rules }))
		.default([]),
});
export type Snapshot = z.infer<typeof snapshotView>;
export interface Actor {
	userId: string;
	scopeId: string;
	sessionId?: string;
}

export const agentCatalogInput = z.object({
	agentId: z.string().min(1),
	connectionId: z.string().min(1),
});
export const agentCatalogView = z.object({
	tools: z.array(
		z.object({
			name: z.string(),
			description: z.string().optional(),
			inputSchema: z.record(z.string(), z.unknown()),
		}),
	),
});
export const toolTestInput = agentCatalogInput.extend({
	name: z.string().min(1).max(256),
	arguments: z
		.record(z.string(), z.unknown())
		.refine(
			(value) => JSON.stringify(value).length <= 100_000,
			"Arguments exceed 100 KB",
		),
});
export const toolTestView = z.object({
	isError: z.boolean(),
	preview: z.string().max(65536),
	truncated: z.boolean(),
	approval: approvalReference.optional(),
});

export const allAgentGrantInput = z.object({
	connectionId: z.string().min(1),
	rules: rulesInput,
});
export const accountStatusView = z.object({
	identifier: z.string(),
	recoveryCodesRemaining: z.number().int(),
	providers: z.array(z.string()),
	recoveryWindowDays: z.number().int(),
});

export const debugSelectionInput = z.object({
	agentIds: z.array(z.string().min(1).max(200)).min(1).max(100),
	connectionIds: z.array(z.string().min(1).max(200)).min(1).max(100),
});
export const debugSessionView = debugSelectionInput.extend({
	id: z.string(),
	stopsAt: z.string(),
	stoppedAt: z.string().nullable(),
	createdAt: z.string(),
});
export const debugStatusView = z.object({
	sessions: z.array(debugSessionView),
	payloads: z.array(
		z.object({
			id: z.string(),
			agentId: z.string(),
			connectionId: z.string(),
			createdAt: z.string(),
			expiresAt: z.string(),
		}),
	),
	activityRetentionDays: z.number(),
	payloadRetentionHours: z.number(),
});
export const debugPayloadView = z.object({
	arguments: z.unknown(),
	result: z.unknown(),
	truncated: z.boolean(),
});
export type DebugSelection = z.infer<typeof debugSelectionInput>;
export type DebugStatus = z.infer<typeof debugStatusView>;
export type DebugPayload = z.infer<typeof debugPayloadView>;

export const renameInput = z.object({
	id: z.string().min(1),
	label: nameInput,
});

// Response allowlists also strip adapter-only fields at the RPC boundary.
export const idView = z.object({ id: z.string() });
export const mutationView = z.object({ ok: z.boolean() });
export const connectionCreatedView = z.object({
	id: z.string(),
	label: z.string(),
	/** The saved address; detection may have added a common MCP path. Older replays omit it. */
	url: z.string().optional(),
	transport: z.enum(["http", "sse"]),
	authentication: z.enum(["headers", "oauth"]),
	status: z.string(),
});
export const agentCreatedView = z.object({ id: z.string(), token: z.string() });
export const connectionOAuthView = z.object({ url: z.string() });
export const verificationView = z.object({
	tools: z.array(z.string()),
	resources: z.array(z.string()),
	prompts: z.array(z.string()),
	/** Upstream descriptions for catalog entries that provide one. */
	descriptions: z
		.array(
			z.object({
				capability,
				name: z.string(),
				description: z.string().max(1000),
			}),
		)
		.optional(),
	/** What the upstream server declares about a tool. Not verified. */
	hints: z
		.array(
			z.object({
				name: z.string(),
				readOnly: z.boolean().optional(),
				destructive: z.boolean().optional(),
			}),
		)
		.optional(),
});
export type Verification = z.infer<typeof verificationView>;
export const recoveryCodesView = z.object({ codes: z.array(z.string()) });
export const accountDeletionView = z.object({ purgeAfter: z.string() });
