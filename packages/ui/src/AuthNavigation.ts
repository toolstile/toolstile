export type AuthMode = "signin" | "signup";

/** Remove presentation state without re-encoding any signed OAuth parameter. */
export function oauthQueryWithoutPresentation(search: string): string {
	return search
		.replace(/^\?/, "")
		.split("&")
		.filter((part) => {
			const key = part.split("=", 1)[0];
			try {
				return decodeURIComponent(key.replace(/\+/g, " ")) !== "authMode";
			} catch {
				return true;
			}
		})
		.join("&");
}

/**
 * A sign-in started on another machine (it sent `device_name`, for example over SSH) waits
 * for the redirect on that machine's loopback address, which this browser cannot reach.
 * Returns that machine's name and the command that delivers the redirect there instead.
 */
export function remoteCallback(
	oauthQuery: string,
	location: string,
): { device: string; command: string } | null {
	const device = new URLSearchParams(oauthQuery)
		.get("device_name")
		// oxlint-disable-next-line eslint/no-control-regex -- strip control characters
		?.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.slice(0, 100);
	if (!device) return null;
	let url: URL;
	try {
		url = new URL(location);
	} catch {
		return null;
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (
		url.protocol !== "http:" ||
		!(
			host === "localhost" ||
			host === "::1" ||
			/^127(\.\d{1,3}){3}$/.test(host)
		)
	)
		return null;
	return {
		device,
		command: `curl -fsS '${url.href.replaceAll("'", "'\\''")}'`,
	};
}

/** Use with TanStack Router history to retain the original signed query bytes. */
export function authorizationModeHref(
	location: { pathname: string; search: string; hash: string },
	mode: AuthMode,
): string {
	const query = oauthQueryWithoutPresentation(location.search);
	return `${location.pathname}?${query ? `${query}&` : ""}authMode=${mode}${location.hash}`;
}

export function authorizationSearch(
	search: Record<string, unknown>,
): Record<string, unknown> & { authMode?: AuthMode } {
	return {
		...search,
		authMode:
			search.authMode === "signup" || search.authMode === "signin"
				? search.authMode
				: undefined,
	};
}

const originalOAuthSearch = Symbol("toolstile.original-oauth-search");
type SearchRecord = Record<string, unknown>;
type PreservedSearch = SearchRecord & {
	[originalOAuthSearch]?: { raw: string; parsed: SearchRecord };
};

/** Keep signed query encoding intact through Router validation and SSR canonicalization. */
export function oauthSearchSerialization(
	parseSearch: (search: string) => SearchRecord,
	stringifySearch: (search: SearchRecord) => string,
) {
	return {
		parseSearch(search: string): SearchRecord {
			const parsed: PreservedSearch = parseSearch(search);
			if (new URLSearchParams(search).has("sig")) {
				// Enumerable symbols survive route search spreads but never become URL parameters.
				parsed[originalOAuthSearch] = { raw: search, parsed: { ...parsed } };
			}
			return parsed;
		},
		stringifySearch(search: PreservedSearch): string {
			const original = search[originalOAuthSearch];
			if (!original) return stringifySearch(search);
			const keys = new Set([
				...Object.keys(original.parsed),
				...Object.keys(search),
			]);
			for (const key of keys) {
				if (
					key !== "authMode" &&
					JSON.stringify(original.parsed[key]) !== JSON.stringify(search[key])
				)
					return stringifySearch(search);
			}
			if (original.parsed.authMode === search.authMode) return original.raw;
			const query = oauthQueryWithoutPresentation(original.raw);
			const mode =
				search.authMode === "signin" || search.authMode === "signup"
					? `authMode=${search.authMode}`
					: "";
			return query || mode ? `?${query}${query && mode ? "&" : ""}${mode}` : "";
		},
	};
}
