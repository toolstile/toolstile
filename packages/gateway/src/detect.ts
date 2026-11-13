import { isIP } from "node:net";
import {
	Client,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";

import type { ConnectionStatus } from "@toolstile/database/connection-status";
import { fetchWithoutRedirects, upstreamUnreachable } from "./network";
import { withSessionCleanup } from "./upstream-cleanup";

type Transport = "http" | "sse";
type Authentication = "headers" | "oauth";
export interface DetectedConnection {
	transport: Transport;
	authentication: Authentication;
	status: ConnectionStatus;
}

export function connectionLabel(value: string) {
	const url = new URL(value);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	return (
		isIP(hostname) ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost")
			? `${url.host}${url.pathname}`
			: hostname.replace(/^(www|mcp)\./i, "")
	).slice(0, 100);
}

/** Call only after destination validation, with the runtime's policy-guarded fetch.
 * The fetch must also validate every subsequent destination (including SSE endpoints).
 * Probes deliberately bypass gateway activity/admission/capture hooks.
 */
export async function detectConnection({
	url,
	headers = {},
	fetch: send,
	timeoutMs = 8_000,
	transport = "auto",
	authentication = "auto",
	probe = false,
}: {
	url: string;
	headers?: Record<string, string>;
	fetch: typeof fetch;
	timeoutMs?: number;
	transport?: Transport | "auto";
	authentication?: Authentication | "auto";
	/** Make a real request even when transport and authentication are both given. */
	probe?: boolean;
}): Promise<DetectedConnection> {
	if (!probe && transport !== "auto" && authentication !== "auto")
		return {
			transport,
			authentication,
			status:
				authentication === "oauth" ? "authentication required" : "configured",
		};
	const hasAuthorization = new Headers(headers).has("authorization");
	const choices: Transport[] =
		transport === "auto" ? ["http", "sse"] : [transport];
	const deadline = Date.now() + timeoutMs;
	for (const [index, choice] of choices.entries()) {
		// Reserve time for legacy fallback even when the HTTP endpoint hangs.
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const controller = new AbortController();
		const budget = Math.max(
			1,
			Math.floor(remaining / (choices.length - index)),
		);
		let unauthorized = false;
		const guardedFetch: typeof fetch = async (input, init) => {
			const signals = [controller.signal];
			const signal =
				init?.signal ?? (input instanceof Request ? input.signal : null);
			if (signal) signals.push(signal);
			const response = await fetchWithoutRedirects(send, input, {
				...init,
				signal: AbortSignal.any(signals),
			});
			if (
				response.status === 401 ||
				(!response.ok && response.headers.has("www-authenticate"))
			) {
				unauthorized = true;
				await response.body?.cancel().catch(() => {});
				throw new UnauthorizedError();
			}
			return response;
		};
		const client = new Client(
			{ name: "toolstile-connection-probe", version: "0.1.0" },
			{ versionNegotiation: { mode: choice === "sse" ? "legacy" : "auto" } },
		);
		const options = { requestInit: { headers }, fetch: guardedFetch };
		const upstream =
			choice === "sse"
				? new SSEClientTransport(new URL(url), options)
				: new StreamableHTTPClientTransport(new URL(url), options);
		withSessionCleanup(client, upstream);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				client.connect(upstream, {
					signal: controller.signal,
					timeout: budget,
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(
							new DOMException("Connection probe timed out", "TimeoutError"),
						);
					}, budget);
				}),
			]);
			const resolved = authentication === "auto" ? "headers" : authentication;
			return {
				transport: choice,
				authentication: resolved,
				status: resolved === "oauth" ? "authentication required" : "reachable",
			};
		} catch (error) {
			if (
				unauthorized ||
				error instanceof UnauthorizedError ||
				(error instanceof Error && error.name === "UnauthorizedError")
			) {
				const resolved =
					authentication !== "auto"
						? authentication
						: hasAuthorization
							? "headers"
							: "oauth";
				return {
					transport: choice,
					authentication: resolved,
					status:
						resolved === "oauth"
							? "authentication required"
							: "needs attention",
				};
			}
			// Only the reason is logged: the URL and headers may carry credentials.
			console.warn(
				"MCP connection probe failed",
				upstreamUnreachable(error) ??
					(error instanceof Error ? error.name : "unknown"),
			);
		} finally {
			clearTimeout(timer);
			await client.close().catch(() => {});
			controller.abort();
			await upstream.close().catch(() => {});
		}
	}
	return {
		transport: transport === "auto" ? "http" : transport,
		authentication: authentication === "auto" ? "headers" : authentication,
		status: "needs attention",
	};
}

/**
 * The check before saving a confirmed address: real requests to exactly this URL with the
 * chosen settings (each transport in turn when none is chosen), never another path and never
 * a rewritten address. `ok` is false when no transport answered as an MCP server, or the
 * server refused the credentials given for header authentication.
 */
export async function checkConnection(
	options: Omit<Parameters<typeof detectConnection>[0], "probe">,
) {
	const detected = await detectConnection({ ...options, probe: true });
	return { ...detected, ok: detected.status !== "needs attention" };
}

/** Endpoint paths many MCP servers use, tried in order when an address has no path. */
export const commonServerPaths = ["/mcp", "/sse"] as const;

/**
 * Detects a connection like `detectConnection`. When an address without a path (or only "/")
 * does not answer as an MCP server, the common MCP paths on the same host are tried in order;
 * the first one that answers is returned as `url`. Otherwise `url` is the address as given.
 * The same guarded fetch checks every attempt, so no other destination is reached.
 */
export async function detectServerAddress(
	options: Parameters<typeof detectConnection>[0],
): Promise<DetectedConnection & { url: string }> {
	const timeoutMs = options.timeoutMs ?? 8_000;
	const first = await detectConnection(options);
	const given = new URL(options.url);
	if (
		first.status !== "needs attention" ||
		(given.pathname !== "/" && given.pathname !== "") ||
		given.search ||
		// Explicit settings skip probing, so another path would tell nothing more.
		(options.transport !== undefined &&
			options.transport !== "auto" &&
			options.authentication !== undefined &&
			options.authentication !== "auto")
	)
		return { ...first, url: options.url };
	// Fallbacks share one more probe budget, so a host that hangs is not waited on twice per path.
	const deadline = Date.now() + timeoutMs;
	for (const path of commonServerPaths) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const candidate = new URL(given);
		candidate.pathname = path;
		const detected = await detectConnection({
			...options,
			url: candidate.href,
			timeoutMs: remaining,
		});
		if (detected.status !== "needs attention")
			return { ...detected, url: candidate.href };
	}
	return { ...first, url: options.url };
}
