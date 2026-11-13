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

export default createServerEntry({
	async fetch(request, options) {
		if (new URL(request.url).pathname === "/live")
			return Response.json(
				{ status: "ok" },
				{ headers: { "Cache-Control": "no-store" } },
			);
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
