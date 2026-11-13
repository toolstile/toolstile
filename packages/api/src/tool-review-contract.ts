import { z } from "zod";

export const toolReviewConnectionInput = z.object({
	connectionId: z.string().min(1).max(200),
});
export const toolReviewModeInput = toolReviewConnectionInput.extend({
	enabled: z.boolean(),
});
export const toolReviewAcceptInput = toolReviewConnectionInput.extend({
	/** Exactly the observed versions the reviewer saw; a newer observation stays held. */
	tools: z
		.array(
			z.object({
				// Upstream names are not length-limited by MCP; accept what was observed.
				name: z.string().min(1).max(4096),
				digest: z.string().regex(/^[0-9a-f]{64}$/),
			}),
		)
		.min(1)
		.max(1000),
});
const definitionVersion = z.object({
	digest: z.string(),
	/** Readable canonical JSON; absent when the definition was too large to keep. */
	snapshot: z.string().optional(),
});
export const toolChangeView = definitionVersion.extend({
	name: z.string(),
	observedAt: z.string(),
	/** The version last accepted under this name; absent for a new tool. */
	previous: definitionVersion.optional(),
});
export const toolReviewStatusView = z.object({
	connectionId: z.string(),
	enabled: z.boolean(),
	enabledAt: z.string().nullable(),
	canReview: z.boolean(),
	reviewedCount: z.number().int(),
	/** Every waiting change; `pending` holds the most recent ones. */
	pendingCount: z.number().int(),
	pending: z.array(toolChangeView),
});
export const toolReviewSummaryView = z.object({
	connections: z.array(
		z.object({
			connectionId: z.string(),
			label: z.string(),
			enabled: z.boolean(),
			pending: z.number().int(),
		}),
	),
});
export type ToolChange = z.infer<typeof toolChangeView>;
export type ToolReviewStatus = z.infer<typeof toolReviewStatusView>;
export type ToolReviewSummary = z.infer<typeof toolReviewSummaryView>;
