/**
 * The stored `connections.status` lifecycle. Plain data with no imports, so browser code may
 * read it too.
 *
 * | From                                      | To                          | Writer                         |
 * | ----------------------------------------- | --------------------------- | ------------------------------ |
 * | (new)                                     | any state but `authenticated` | the address check when saving |
 * | any state but a sign-in state             | `reachable` / `authenticated` | a tool check that succeeded   |
 * | `configured`, `reachable`, `authenticated` | `needs attention`          | a tool check the server failed |
 * | any                                       | `authenticated`             | a completed browser sign-in    |
 * | `authenticated` (the failing grant only)  | `needs reconnection`        | a refresh the provider refused |
 *
 * Sign-in states change only through sign-in: a tool check never writes over them.
 */
const connectionStatuses = [
	"configured",
	"reachable",
	"authentication required",
	"authenticated",
	"needs reconnection",
	"needs attention",
] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

/** States only a completed browser sign-in leaves. */
export const signInStatuses = [
	"authentication required",
	"needs reconnection",
] as const satisfies readonly ConnectionStatus[];

/** Whether only a completed browser sign-in can move a connection out of this status. */
export function isSignInStatus(status: string): boolean {
	return (signInStatuses as readonly string[]).includes(status);
}

/** States a failed tool check may replace with `needs attention`. */
export const checkFailureFrom = [
	"configured",
	"reachable",
	"authenticated",
] as const satisfies readonly ConnectionStatus[];

/** The status a successful tool check records for a connection's authentication method. */
export function checkedStatus(authentication: string): ConnectionStatus {
	return authentication === "oauth" ? "authenticated" : "reachable";
}
