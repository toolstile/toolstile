/**
 * Starts browser sign-in for a connection just added and sends the browser to the provider.
 * "left" once the browser is leaving; "stale" when the page moved on while sign-in was starting,
 * so nothing more should happen; "failed" when it could not start, so the caller shows the
 * sign-in dialog, where the reason is visible.
 */
export async function leaveForSignIn(
	start: () => Promise<{ url: string }>,
	isCurrent: () => boolean,
): Promise<"left" | "stale" | "failed"> {
	let url: string;
	try {
		({ url } = await start());
	} catch {
		return isCurrent() ? "failed" : "stale";
	}
	if (!isCurrent()) return "stale";
	window.location.assign(url);
	return "left";
}

/**
 * After leaving for the provider, Back can restore this page from the browser cache with the
 * list from before the connection was saved; reload it then so the new connection shows.
 */
export function refreshOnReturn(reload: () => Promise<unknown>) {
	window.addEventListener(
		"pageshow",
		(event) => {
			if (event.persisted) void reload().catch(() => undefined);
		},
		{ once: true },
	);
}
