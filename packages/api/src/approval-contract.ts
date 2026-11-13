import { z } from "zod";

export const approvalStatus = z.enum([
	"pending",
	"approved",
	"claimed",
	"consumed",
	"denied",
	"expired",
	"invalidated",
]);
export type ApprovalStatus = z.infer<typeof approvalStatus>;
export const approvalListFilter = z.enum([
	"pending",
	"approved",
	"history",
	"all",
]);
export const approvalListInput = z.object({
	status: approvalListFilter.optional(),
	query: z.string().trim().max(100).optional(),
	page: z.number().int().min(1).max(1000).optional(),
});
export const approvalSummary = z.object({
	id: z.string(),
	connectionId: z.string(),
	connectionLabel: z.string(),
	agentId: z.string(),
	agentLabel: z.string(),
	tool: z.string(),
	status: approvalStatus,
	createdAt: z.string(),
	expiresAt: z.string(),
	decidedAt: z.string().nullable().optional(),
	canDecide: z.boolean(),
});
export const approvalDetail = approvalSummary.extend({
	/** The exact forwarded parameters; absent once purged or for non-reviewers. */
	parameters: z.record(z.string(), z.unknown()).optional(),
	decidedBy: z.string().nullable().optional(),
	/** Host-decorated from live authorized state: upstream origin only. */
	destination: z.string().optional(),
	/** Selected account label and owner, as the host currently resolves them. */
	accountLabel: z.string().optional(),
	requesterLabel: z.string().optional(),
});
export const approvalListView = z.object({
	requests: z.array(approvalSummary),
	total: z.number().int(),
});
export const approvalDecisionInput = z.object({
	id: z.string().min(1).max(200),
	decision: z.enum(["approve", "deny"]),
});
export const approvalReference = z.object({
	id: z.string(),
	status: z.enum(["pending", "denied", "busy"]),
	expiresAt: z.string(),
	reviewUrl: z.string().optional(),
});
export type ApprovalSummary = z.infer<typeof approvalSummary>;
export type ApprovalDetail = z.infer<typeof approvalDetail>;
export type ApprovalListInput = z.infer<typeof approvalListInput>;
export type ApprovalList = z.infer<typeof approvalListView>;
export const APPROVAL_PAGE_SIZE = 25;
