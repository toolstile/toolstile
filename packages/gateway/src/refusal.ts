/**
 * Why the gateway refused a capability. Agents only learn what their own grants already
 * reveal: the name they asked for and the general reason, never other agents' rules.
 */
export type RefusalReason = "not_granted" | "blocked" | "unreviewed";

const explanations: Record<RefusalReason, string> = {
	not_granted:
		"Toolstile has not granted this agent access to it. Ask whoever manages this agent's access in Toolstile to grant it",
	blocked:
		"Toolstile blocks it for this agent. An explicit block wins over every other rule; ask whoever manages this agent's access to remove the block if it is needed",
	unreviewed:
		"Its definition is new or changed since it was last reviewed, so Toolstile holds it until someone reviews the change. Ask the connection's reviewer to review it in Toolstile, then list tools again",
};

export class AccessRefusedError extends Error {
	constructor(
		readonly reason: RefusalReason,
		subject: string,
		hint?: string,
	) {
		super(
			`${subject} is unavailable: ${explanations[reason]}${hint ? ` (${hint})` : ""}.`,
		);
		this.name = "AccessRefusedError";
	}
}

/** The activity outcome a refusal is recorded with. */
export const refusalOutcome = (reason: RefusalReason) =>
	reason === "unreviewed" ? "unreviewed" : "denied";
