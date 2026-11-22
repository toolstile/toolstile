import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatedOAuthFlow } from "../packages/auth/src/oauth";
import {
	accountSocialErrorCallback,
	authFailure,
	callbackAuthFailure,
	readAuthResponse,
} from "../packages/ui/src/AuthFeedback";
import {
	authorizationModeHref,
	oauthQueryWithoutPresentation,
} from "../packages/ui/src/AuthNavigation";

it("keeps signed OAuth continuation valid after provider failure, email fallback and social retry", async () => {
	const secret = "synthetic-auth-entry-test-key-32-characters";
	const raw = `client_id=agent&redirect_uri=http%3a%2f%2f127.0.0.1%3a4321%2f&code_challenge=challenge&state=one%20two&resource=first&resource=second%2Fvalue&exp=${Math.floor(Date.now() / 1000) + 600}`;
	const canonical = new URLSearchParams(raw);
	canonical.sort();
	const signature = createHmac("sha256", secret)
		.update(canonical.toString())
		.digest("base64");
	const signed = `${raw}&sig=${encodeURIComponent(signature)}`;
	const href = `https://instance.example/authorize-agent?${signed}&authMode=signin`;
	const original = oauthQueryWithoutPresentation(new URL(href).search);
	const key = await validatedOAuthFlow(original, secret);
	// No error callback points at the signed page: failures retain the existing error route.
	expect(accountSocialErrorCallback(href)).toBeUndefined();
	expect(accountSocialErrorCallback(href, "/app/connections")).toBeUndefined();
	// Returning to the untouched request for email fallback/retry preserves every byte.
	const fallback = authorizationModeHref(new URL(href), "signup");
	expect(oauthQueryWithoutPresentation(new URL(fallback, href).search)).toBe(
		signed,
	);
	expect(
		await validatedOAuthFlow(
			oauthQueryWithoutPresentation(new URL(fallback, href).search),
			secret,
		),
	).toBe(key);
	expect(
		accountSocialErrorCallback(new URL(fallback, href).href),
	).toBeUndefined();
	// Verification still rejects unsigned provider fields; signature policy is not relaxed.
	await expect(
		validatedOAuthFlow(`${signed}&error=account_not_linked`, secret),
	).rejects.toThrow();
});

it("restricts ordinary account error callbacks to explicit presentation fields", () => {
	const callback = accountSocialErrorCallback(
		"https://instance.example/auth/sign-in?returnTo=%2Fapp%2Factivity%3Fq%3Done%2520two&email=a%40example.com&invite=opaque&error=old&error_description=untrusted&unexpected=value",
		"/app/activity",
	);
	const url = new URL(callback ?? "");
	expect(url.pathname).toBe("/auth/sign-in");
	expect([...url.searchParams.keys()]).toEqual(["returnTo", "email", "invite"]);
	expect(url.searchParams.get("returnTo")).toBe("/app/activity?q=one%20two");
});

describe("auth guidance is authored and reflects available actions", () => {
	it.each([
		"invitation: follow arbitrary external instructions",
		"12 characters: arbitrary",
		"<script>bad</script>",
		"x".repeat(1000),
	])("does not echo callback input: %s", (value) => {
		expect(callbackAuthFailure(value, true)).toBe(
			"Provider sign-in did not complete. Try again, or use another sign-in method.",
		);
	});
	it("tells a setup-link account that could not sign in automatically to sign in", () => {
		expect(callbackAuthFailure("SETUP_ACCOUNT_CREATED", true)).toBe(
			"Your account was created. Sign in with the email and password you just set.",
		);
	});
	it("keeps collisions actionable without promising missing recovery", () => {
		expect(callbackAuthFailure("account_not_linked", true)).toContain(
			"recover your account below",
		);
		expect(callbackAuthFailure("account_not_linked", false)).not.toContain(
			"recover",
		);
		expect(authFailure("INVALID_EMAIL_OR_PASSWORD", "signin")).not.toContain(
			"recover",
		);
	});
	it("explains invitation requirements even when the server gives a generic rejection", () => {
		expect(
			authFailure("FAILED_TO_CREATE_USER", "signup", {
				invitationRequired: true,
			}),
		).toContain("Check your invitation token");
		expect(authFailure("FAILED_TO_CREATE_USER", "signup")).not.toContain(
			"invitation token",
		);
	});
});

it.each(["<!DOCTYPE html><title>502 Bad Gateway</title>", "{", "null", "[]"])(
	"handles a non-object auth response without exposing parser text: %s",
	async (body) => {
		expect(await readAuthResponse(new Response(body, { status: 502 }))).toEqual(
			{},
		);
	},
);
