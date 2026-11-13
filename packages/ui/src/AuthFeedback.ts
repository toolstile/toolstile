import { safeLocalReturnTo } from "./AccountNavigation";

type Method = "signin" | "signup" | "social";
type Context = { recovery?: boolean; invitationRequired?: boolean };

/** All guidance is authored here, including unknown server or callback failures. */
export function authFailure(
	value: unknown,
	method: Method,
	context: Context = {},
) {
	const code = String(value ?? "")
		.toLowerCase()
		.replaceAll("_", " ");
	const recovery = context.recovery ? ", or recover your account below" : "";
	if (/not linked|already linked/.test(code))
		return `This email uses a different sign-in method. Sign in with your original method${recovery}.`;
	if (/already exists|already registered/.test(code))
		return `An account already uses this email. Sign in instead${recovery}.`;
	if (/invalid email or password|invalid password|user not found/.test(code))
		return `Email or password is incorrect. Try again${recovery}.`;
	if (/too many|rate limit/.test(code))
		return "Too many attempts. Wait a moment, then try again.";
	if (
		method === "signup" &&
		(/invitation/.test(code) || context.invitationRequired)
	)
		return "Your account could not be created. Check your invitation token, or ask the person running this instance for a new invitation.";
	if (method === "social")
		return "Provider sign-in did not complete. Try again, or use another sign-in method.";
	return method === "signup"
		? "Your account could not be created. Try again, or sign in if you already have an account."
		: `Sign-in did not complete. Try again${recovery}.`;
}

/** URL input is a bounded code, never provider-supplied prose. */
export function callbackAuthFailure(value: string | null, recovery: boolean) {
	return authFailure(
		value && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined,
		"social",
		{ recovery },
	);
}

/** Embedded authorization retains its signed query untouched and its existing error route. */
export function accountSocialErrorCallback(href: string, callbackURL?: string) {
	if (callbackURL === undefined) return undefined;
	const source = new URL(href);
	if (source.searchParams.has("sig")) return undefined;
	const callback = new URL(source.pathname, source.origin);
	const returnTo = source.searchParams.get("returnTo");
	if (returnTo)
		callback.searchParams.set("returnTo", safeLocalReturnTo(returnTo));
	for (const key of ["email", "invite"]) {
		const value = source.searchParams.get(key);
		if (value) callback.searchParams.set(key, value);
	}
	return callback.href;
}

/** A proxy error page or malformed body must not become browser parser-error copy. */
export async function readAuthResponse(
	response: Response,
): Promise<Record<string, unknown>> {
	const body: unknown = await response.json().catch(() => null);
	return body && typeof body === "object" && !Array.isArray(body)
		? (body as Record<string, unknown>)
		: {};
}
