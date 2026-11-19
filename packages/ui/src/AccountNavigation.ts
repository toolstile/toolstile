/** General account navigation only. Signed agent authorization uses AuthNavigation instead. */
export const dashboardHref = "/app/connections";
const localOrigin = "https://toolstile.invalid";
const hasControlCharacters = (value: string) => {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 32 || code === 127) return true;
	}
	return false;
};
const privateParams =
	/^(?:password|code|token|access_token|refresh_token|id_token|client_secret|secret|sig|invitationToken|payload|capturedPayload)$/i;
const forbiddenPath =
	/^\/(?:auth|recover-account|api|oauth|mcp|\.well-known|authorize-agent|consent-agent)(?:\/|$)/i;
/** The CLI approval page sits under /auth but outside the signed-out account pages, so signing
 * in can return to it without a loop. */
const signedInAccountPath = /^\/auth\/device$/;

/** Validate ordinary root-relative page destinations, preserving accepted input bytes. */
export function validateLocalReturnTo(
	value: unknown,
	maxLength = 4096,
): string | undefined {
	if (
		typeof value !== "string" ||
		!Number.isSafeInteger(maxLength) ||
		maxLength < 1 ||
		value.length > maxLength ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		/[\\\s]/.test(value) ||
		hasControlCharacters(value)
	)
		return undefined;
	try {
		// URLSearchParams replaces malformed UTF-8; reject it before parsing keys.
		decodeURIComponent(value);
		const url = new URL(value, localOrigin);
		let path = url.pathname;
		for (let i = 0; i < 5; i++) {
			const decoded = decodeURIComponent(path);
			if (
				/[\\\s]/.test(decoded) ||
				hasControlCharacters(decoded) ||
				decoded.startsWith("//")
			)
				return undefined;
			if (decoded === path) break;
			path = decoded;
		}
		if (path.includes("%")) return undefined;
		// Normalizing decoded dot segments also catches encoded auth-loop paths.
		path = new URL(path, localOrigin).pathname;
		if (
			url.origin !== localOrigin ||
			path.startsWith("//") ||
			(forbiddenPath.test(path) && !signedInAccountPath.test(path))
		)
			return undefined;
		for (const key of [
			...url.searchParams.keys(),
			...new URLSearchParams(url.hash.slice(1)).keys(),
		])
			if (privateParams.test(key)) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

/** General account navigation keeps its established default and destination limit. */
export function safeLocalReturnTo(
	value: unknown,
	fallback = dashboardHref,
): string {
	return validateLocalReturnTo(value, 8192) ?? fallback;
}
export type AccountAuthSearch = {
	returnTo?: string;
	invite?: string;
	email?: string;
};
const bounded = (value: unknown, max: number) =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= max &&
	!hasControlCharacters(value)
		? value
		: undefined;
export function accountAuthSearch(
	search: Record<string, unknown>,
): AccountAuthSearch {
	return {
		returnTo:
			search.returnTo === undefined
				? undefined
				: safeLocalReturnTo(search.returnTo),
		invite: bounded(search.invite, 2048),
		email: bounded(search.email, 320),
	};
}
export type AccountAuthPage = "sign-in" | "sign-up" | "recover-account";
export function accountAuthHref(
	page: AccountAuthPage,
	context: AccountAuthSearch = {},
): string {
	const safe = accountAuthSearch(context);
	const params = new URLSearchParams();
	for (const key of ["returnTo", "invite", "email"] as const)
		if (safe[key]) params.set(key, safe[key]);
	return `/auth/${page}${params.size ? `?${params}` : ""}`;
}
/** Move account context out of a dashboard URL without nesting invitation secrets in returnTo. */
export function accountAuthContext(href: string): AccountAuthSearch {
	const url = new URL(href, localOrigin);
	const context = accountAuthSearch(Object.fromEntries(url.searchParams));
	for (const key of [...url.searchParams.keys()])
		if (
			["authMode", "invite", "email", "returnTo"].includes(key) ||
			privateParams.test(key)
		)
			url.searchParams.delete(key);
	return {
		...context,
		returnTo: safeLocalReturnTo(`${url.pathname}${url.search}${url.hash}`),
	};
}
