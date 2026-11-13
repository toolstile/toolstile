// Gateway status vocabulary; kept free of StyleX so it can be unit tested.
import { type ConnectionStatus, isSignInStatus } from "@toolstile/api/contract";

export type StatusTone = "good" | "warning" | "action" | "bad" | "neutral";

const tones: Record<string, StatusTone> = {
	reachable: "good",
	authenticated: "good",
	authorized: "good",
	"needs attention": "warning",
	"authentication required": "action",
	"needs reconnection": "action",
};

/** Fixed user-facing vocabulary for gateway statuses. */
const labels: Record<string, string> = {
	reachable: "Connected",
	authenticated: "Connected",
	"authentication required": "Needs sign-in",
	"needs reconnection": "Needs sign-in",
	"needs attention": "Needs attention",
	configured: "Not verified",
	authorized: "Authorized",
};

/** Maps connection, device and agent statuses to a badge tone; unknown values stay neutral. */
export function statusTone(status: string): StatusTone {
	return tones[status.trim().toLowerCase()] ?? "neutral";
}

/** The fixed label for a gateway status; unknown values are shown as given. */
export function statusLabel(status: string) {
	return labels[status.trim().toLowerCase()] ?? status;
}

/** What a connection status that is not OK means, in one or two plain sentences. */
const hints: Partial<Record<ConnectionStatus, string>> = {
	"needs attention": "Check its address and token",
	"authentication required": "Sign in to load its tools",
	"needs reconnection": "Sign in again to restore access",
	configured: "Not checked yet",
};

/**
 * Whether the last check found no MCP server at the connection's address. Sign-in states are
 * reachable: the user can finish them.
 */
export function connectionUnreachable(status: string) {
	return status.trim().toLowerCase() === "needs attention";
}

/**
 * Whether a browser sign-in connection has no working sign-in yet: it was never completed, or
 * the provider requires it again. Only signing in changes these states.
 */
export function connectionNeedsSignIn(connection: {
	status: string;
	authentication?: string;
}) {
	return (
		connection.authentication === "oauth" &&
		isSignInStatus(connection.status.trim().toLowerCase())
	);
}

/** Whether a request was refused for lack of permission rather than failing at the server. */
export function authorizationRefused(error: unknown) {
	if (!error || typeof error !== "object") return false;
	const { code, status } = error as { code?: unknown; status?: unknown };
	return (
		code === "FORBIDDEN" ||
		code === "UNAUTHORIZED" ||
		status === 401 ||
		status === 403
	);
}

/** Whether a connection's tools can load without a step first: it is reachable and signed in. */
export function toolsLoadable(status: string) {
	const current = status.trim().toLowerCase();
	return current === "reachable" || current === "authenticated";
}

/** The connection Access opens on without a selection: the first one Toolstile can reach. */
export function defaultAccessConnection<T extends { status: string }>(
	connections: readonly T[],
) {
	return (
		connections.find(({ status }) => !connectionUnreachable(status)) ??
		connections[0]
	);
}

/** Explanation for a connection status that needs a next step; undefined when it is OK. */
export function connectionStatusHint(status: string) {
	return hints[status.trim().toLowerCase() as ConnectionStatus];
}

/**
 * The connection status to show. A tool check made in this browser is newer than the stored
 * status: success means the server is reachable, failure means it needs attention. Sign-in
 * states always win, because only signing in changes them.
 */
export function connectionStatus(status: string, check?: "passed" | "failed") {
	const current = status.trim().toLowerCase();
	if (!check || isSignInStatus(current)) return status;
	if (check === "passed")
		return current === "needs attention" || current === "configured"
			? "reachable"
			: status;
	return current === "reachable" ||
		current === "authenticated" ||
		current === "configured"
		? "needs attention"
		: status;
}

/** Server messages that say nothing about the cause; callers show their own explanation instead. */
const genericMessages = new Set([
	"",
	"internal server error",
	"request failed",
	"failed to fetch",
	"network error",
	"bad gateway",
	"service unavailable",
	"gateway timeout",
	"load failed",
]);

/** The message of a failure when it explains something; undefined for bare transport errors. */
export function specificMessage(failure: unknown) {
	const message = (
		failure instanceof Error
			? failure.message
			: typeof failure === "string"
				? failure
				: ""
	).trim();
	return genericMessages.has(message.toLowerCase().replace(/\.$/, ""))
		? undefined
		: message;
}

/**
 * Longest MCP server address accepted, matching the server's limit. The field has no maxLength:
 * a longer pasted address must show this error rather than be cut to a valid but wrong one.
 */
const serverAddressMax = 2048;

/**
 * Reads an MCP server address typed by a person: trims spaces and adds https:// when no scheme
 * was given, so "mcp.example.com/mcp" works. Other schemes are refused with a next step; the
 * server still decides which hosts it may reach.
 */
export function readServerAddress(value: string): {
	url: string;
	error?: string;
} {
	const trimmed = value.trim();
	if (!trimmed)
		return {
			url: "",
			error: "Enter the MCP server's address, like https://example.com/mcp.",
		};
	// "host:3000" has a port, not a scheme; a scheme is followed by "//" or a non-digit.
	const scheme = /^([a-z][a-z\d+.-]*):(?:\/\/|(?!\d))/i
		.exec(trimmed)?.[1]
		?.toLowerCase();
	if (scheme && scheme !== "https" && scheme !== "http")
		return { url: trimmed, error: "Start the address with https://." };
	const url = scheme ? trimmed : `https://${trimmed}`;
	if (url.length > serverAddressMax)
		return {
			url: trimmed,
			error:
				"This address is too long. Use an address of up to 2,048 characters.",
		};
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {}
	if (!parsed?.hostname || /\s/.test(url))
		return {
			url: trimmed,
			error: "Enter a full address, like https://example.com/mcp.",
		};
	return { url };
}

/** Whether two addresses point at the same MCP endpoint, ignoring case in the host and a trailing slash. */
export function sameServerAddress(a: string, b: string) {
	const key = (value: string) => {
		try {
			const url = new URL(value);
			return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
		} catch {
			return value;
		}
	};
	return key(a) === key(b);
}
