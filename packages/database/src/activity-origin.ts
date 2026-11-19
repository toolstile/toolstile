/**
 * Who made a request recorded in `activity.origin`. Plain data with no imports, so browser
 * code may read it too. Written once, when the gateway records the request; never updated.
 *
 * | Origin      | Meaning                                                                      |
 * | ----------- | ---------------------------------------------------------------------------- |
 * | `agent`     | An authorized agent sent it to the MCP endpoint.                             |
 * | `dashboard` | The dashboard sent it for the user (checks, review baselines, tool tests).   |
 */
export const activityOrigins = ["agent", "dashboard"] as const;
export type ActivityOrigin = (typeof activityOrigins)[number];

/**
 * The stored origin, or for rows recorded before origins were stored, the one implied by the
 * agent label the dashboard used ("Dashboard" and "Dashboard test / <agent>").
 */
export function activityOrigin(
	stored: ActivityOrigin | null,
	agentLabel: string,
): ActivityOrigin {
	if (stored) return stored;
	return agentLabel === "Dashboard" ||
		agentLabel.startsWith("Dashboard test / ")
		? "dashboard"
		: "agent";
}
