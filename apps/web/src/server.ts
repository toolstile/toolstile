import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { isDraining } from "./server/lifecycle";

/** No page of this instance may be framed (clickjacking on consent and settings pages). */
function withFrameProtection(response: Response) {
	const headers = new Headers(response.headers);
	headers.set("X-Frame-Options", "DENY");
	const policy = headers.get("Content-Security-Policy");
	if (!policy) headers.set("Content-Security-Policy", "frame-ancestors 'none'");
	else if (!/(^|;)\s*frame-ancestors\b/i.test(policy))
		headers.set("Content-Security-Policy", `${policy}; frame-ancestors 'none'`);
	// A new Response keeps streaming bodies (MCP event streams) unbuffered.
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Host names a plain HTTP origin may use: it is served only on this machine. */
const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
let configuredOrigin: URL | null | undefined;
/**
 * DNS rebinding: a web page can point its own host name at 127.0.0.1 and then reach a
 * loopback-only instance as a same-origin request. Its Host header still names that page,
 * so an instance on a plain HTTP loopback origin answers only requests addressed to it.
 * HTTPS origins sit behind a TLS proxy that already routes by host name.
 */
function foreignHost(request: Request) {
	if (configuredOrigin === undefined) {
		const origin = URL.parse(process.env.BETTER_AUTH_URL ?? "");
		configuredOrigin =
			origin?.protocol === "http:" && loopbackHosts.includes(origin.hostname)
				? origin
				: null;
	}
	return (
		!!configuredOrigin &&
		request.headers.get("host")?.toLowerCase() !== configuredOrigin.host
	);
}

export default createServerEntry({
	async fetch(request, options) {
		const path = new URL(request.url).pathname;
		if (path === "/live")
			return Response.json(
				{ status: "ok" },
				{ headers: { "Cache-Control": "no-store" } },
			);
		// Health checks may address the container or process by another name.
		if (path !== "/health" && foreignHost(request))
			return new Response("Misdirected request", {
				status: 421,
				headers: { "Cache-Control": "no-store" },
			});
		if (isDraining())
			return Response.json(
				{ status: "draining" },
				{
					status: 503,
					headers: { "Cache-Control": "no-store", Connection: "close" },
				},
			);
		return withFrameProtection(await handler.fetch(request, options));
	},
});
