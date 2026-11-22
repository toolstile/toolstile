import { definePlugin } from "nitro";

/** Host names a plain HTTP origin may use: it is served only on this machine. */
const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

/**
 * DNS rebinding: a web page can point its own host name at 127.0.0.1 and then reach a
 * loopback-only instance as a same-origin request. Its Host header still names that page,
 * so an instance on a plain HTTP loopback origin answers only requests addressed to it.
 * HTTPS origins sit behind a TLS proxy that already routes by host name. This wraps the
 * whole application, ahead of Nitro's static assets; health checks may address the process
 * by another name.
 */
export default definePlugin((app) => {
	const origin = URL.parse(process.env.BETTER_AUTH_URL ?? "");
	if (origin?.protocol !== "http:" || !loopbackHosts.includes(origin.hostname))
		return;
	const next = app.fetch;
	app.fetch = (request) => {
		const path = new URL(request.url).pathname;
		if (
			path === "/live" ||
			path === "/health" ||
			request.headers.get("host")?.toLowerCase() === origin.host
		)
			return next(request);
		return new Response("Misdirected request", {
			status: 421,
			headers: { "Cache-Control": "no-store" },
		});
	};
});
