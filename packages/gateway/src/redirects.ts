/**
 * A response that would send the caller elsewhere: any 3xx except 304 Not Modified,
 * which answers a conditional request in place, or an opaque manual redirect.
 */
export function isRedirectResponse(response: Response) {
	return (
		String(response.type) === "opaqueredirect" ||
		(response.status >= 300 && response.status < 400 && response.status !== 304)
	);
}
