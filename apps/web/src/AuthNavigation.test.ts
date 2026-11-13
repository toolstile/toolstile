import {
	defaultParseSearch,
	defaultStringifySearch,
} from "@tanstack/react-router";
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { validatedOAuthFlow } from "../../../packages/auth/src/oauth";
import {
	authorizationModeHref,
	authorizationSearch,
	oauthQueryWithoutPresentation,
	oauthSearchSerialization,
} from "../../../packages/ui/src/AuthNavigation";

const serialization = oauthSearchSerialization(
	defaultParseSearch,
	defaultStringifySearch,
);

async function signedQuery() {
	const raw = `client_id=fixture%2fclient&redirect_uri=https%3a%2f%2fclient.invalid%2fcallback&code_challenge=fixture&scope=openid%20profile&resource=https%3a%2f%2fserver.invalid%2fmcp&resource=https%3A%2F%2Fother.invalid%2Fmcp&state=a%2Bb%2fc&exp=${Math.floor(Date.now() / 1000) + 600}`;
	const canonical = new URLSearchParams();
	for (const [key, value] of [...new URLSearchParams(raw)].sort(
		([a, av], [b, bv]) =>
			a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
	))
		canonical.append(key, value);
	const secret = "fixture-only-auth-navigation-signature-secret";
	const sig = await makeSignature(canonical.toString(), secret);
	return { raw: `${raw}&sig=${encodeURIComponent(sig)}`, secret };
}

describe("authorization presentation search boundary", () => {
	it("retains signed bytes and signature after validation, mode switches, and repeated parameters", async () => {
		const { raw, secret } = await signedQuery();
		const expectedFlow = await validatedOAuthFlow(raw, secret);
		const parsed = serialization.parseSearch(`?${raw}`);
		const validated = authorizationSearch(parsed);
		expect(validated.authMode).toBeUndefined();
		expect(serialization.stringifySearch(validated)).toBe(`?${raw}`);
		for (const mode of ["signup", "signin"] as const) {
			const next = serialization.stringifySearch({
				...validated,
				authMode: mode,
			});
			expect(next).toBe(`?${raw}&authMode=${mode}`);
			const restored = oauthQueryWithoutPresentation(next);
			expect(restored).toBe(raw);
			expect(await validatedOAuthFlow(restored, secret)).toBe(expectedFlow);
			await expect(validatedOAuthFlow(next.slice(1), secret)).rejects.toThrow();
		}
	});
	it("strips only presentation segments without normalizing signed encoding or malformed data", () => {
		const raw =
			"state=plus+space%20and%2b&sig=fixture&bad%=keep&resource=a&resource=b";
		expect(
			oauthQueryWithoutPresentation(
				`?authMode=signup&${raw}&auth%4Dode=signin`,
			),
		).toBe(raw);
		expect(
			authorizationModeHref(
				{
					pathname: "/consent-agent",
					search: `?${raw}&authMode=signup`,
					hash: "#choice",
				},
				"signin",
			),
		).toBe(`/consent-agent?${raw}&authMode=signin#choice`);
	});
	it("keeps ordinary search validation and serialization on the default path", () => {
		const search = "?page=2&filter=connected&authMode=invalid";
		const normal = defaultParseSearch(search);
		expect(serialization.parseSearch(search)).toEqual(normal);
		const validated = authorizationSearch(normal);
		expect(validated.authMode).toBeUndefined();
		expect(serialization.stringifySearch(validated)).toBe(
			defaultStringifySearch(validated),
		);
	});
	it("does not preserve stale raw bytes when protocol values actually change", () => {
		const parsed = serialization.parseSearch(
			"?client_id=fixture%2fclient&sig=fixture",
		);
		const updated = { ...parsed, client_id: "changed" };
		expect(serialization.stringifySearch(updated)).toBe(
			defaultStringifySearch(updated),
		);
	});
});
