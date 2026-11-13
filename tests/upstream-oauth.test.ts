import { describe, expect, it } from "vitest";
import { authorizeUpstream } from "../packages/gateway/src/oauth";
import { oauthFixture } from "./oauth-fixture";

const fixture = oauthFixture;

describe("SDK-managed upstream OAuth", () => {
	it("persists discovery, dynamic registration and PKCE across a redirect before exchanging tokens", async () => {
		const f = fixture();
		expect(
			await authorizeUpstream(f.provider(), {
				serverUrl: f.server,
				fetchFn: f.request,
				forceReauthorization: true,
			}),
		).toBe("REDIRECT");
		expect(f.redirect()?.origin).toBe(f.issuer);
		expect(f.redirect()?.searchParams.get("state")).toBe("fixture-state");
		expect(f.redirect()?.searchParams.get("code_challenge_method")).toBe(
			"S256",
		);
		expect(f.saved().verifier).toBeTypeOf("string");
		expect(f.saved().discovery).toBeDefined();
		expect(
			await authorizeUpstream(f.provider(), {
				serverUrl: f.server,
				fetchFn: f.request,
				authorizationCode: "fixture-code",
				iss: f.issuer,
			}),
		).toBe("AUTHORIZED");
		expect(f.saved().tokens?.access_token).toBe("fixture-access-1");
		expect(f.saved().tokens?.issuer).toBe(f.issuer);
	});
	it("rejects an authorization-server mix-up before redeeming a code", async () => {
		const f = fixture();
		await authorizeUpstream(f.provider(), {
			serverUrl: f.server,
			fetchFn: f.request,
			forceReauthorization: true,
		});
		await expect(
			authorizeUpstream(f.provider(), {
				serverUrl: f.server,
				fetchFn: f.request,
				authorizationCode: "fixture-code",
				iss: "https://attacker.example",
			}),
		).rejects.toThrow();
		expect(f.tokenRequests()).toBe(0);
		expect(f.saved().tokens).toBeUndefined();
	});
	it("refreshes an expired account without switching identity and keeps an unrotated refresh token", async () => {
		const f = fixture();
		await authorizeUpstream(f.provider(), {
			serverUrl: f.server,
			fetchFn: f.request,
			forceReauthorization: true,
		});
		await authorizeUpstream(f.provider(), {
			serverUrl: f.server,
			fetchFn: f.request,
			authorizationCode: "fixture-code",
			iss: f.issuer,
		});
		f.expire();
		const runtime = f.provider(false);
		expect(
			await authorizeUpstream(runtime, {
				serverUrl: f.server,
				fetchFn: f.request,
			}),
		).toBe("AUTHORIZED");
		expect(runtime.tokens()?.access_token).toBe("fixture-access-2");
		expect(runtime.tokens()?.refresh_token).toBe("fixture-refresh");
		expect(runtime.tokens({ issuer: "https://other.example" })).toBeUndefined();
		expect(
			await runtime.clientInformation({ issuer: "https://other.example" }),
		).toBeUndefined();
		await runtime.invalidateCredentials("tokens");
		expect(runtime.tokens()).toBeUndefined();
		expect(f.saved().tokens).toBeUndefined();
	});
});
