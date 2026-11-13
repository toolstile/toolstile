import { z } from "zod";

// Instance settings tables belong to schema.ts; this module owns API validation only.
export const operatorSettingsInput = z
	.object({
		registrationPolicy: z.enum(["invite-only", "open"]),
		recoveryWindowDays: z.number().int().min(0).max(365),
		allowPrivateNetwork: z.boolean(),
		activityRetentionDays: z.number().int().min(1).max(3650),
		payloadRetentionHours: z.number().int().min(1).max(24),
		telemetryEnabled: z.boolean(),
	})
	.strict();
export const invitationInput = z
	.object({
		email: z.email().optional(),
		expiresInHours: z.number().int().min(1).max(168).default(24),
	})
	.strict();
export type OperatorSettings = z.infer<typeof operatorSettingsInput>;
export const defaultOperatorSettings: OperatorSettings = {
	registrationPolicy: "invite-only",
	recoveryWindowDays: 7,
	allowPrivateNetwork: true,
	activityRetentionDays: 30,
	payloadRetentionHours: 24,
	telemetryEnabled: true,
};
