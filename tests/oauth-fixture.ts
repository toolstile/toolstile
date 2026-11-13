import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
	type UpstreamOAuthData,
	UpstreamOAuthProvider,
	UpstreamReconnectRequired,
} from "../packages/gateway/src/oauth";
import { defined } from "./assertions";
export function oauthFixture(
	callbackUrl = "https://gateway.example/oauth/upstream/callback",
) {
	const server = "https://mcp.example/mcp",
		issuer = "https://accounts.example";
	let saved: UpstreamOAuthData = { version: 1 },
		redirect: URL | undefined,
		tokenRequests = 0;
	const provider = (interactive = true) =>
		new UpstreamOAuthProvider({
			callbackUrl,
			state: "fixture-state",
			data: saved,
			save: async (data) => {
				saved = data;
			},
			redirect: async (url) => {
				if (!interactive) throw new UpstreamReconnectRequired();
				redirect = url;
			},
		});
	const request: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.origin === "https://mcp.example" &&
			url.pathname.includes(".well-known/oauth-protected-resource")
		)
			return Response.json({
				resource: server,
				authorization_servers: [issuer],
				scopes_supported: ["mcp:access"],
			});
		if (url.href === `${issuer}/.well-known/oauth-authorization-server`)
			return Response.json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				registration_endpoint: `${issuer}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				authorization_response_iss_parameter_supported: true,
			});
		if (url.href === `${issuer}/register`)
			return Response.json(
				{
					client_id: "fixture-client",
					redirect_uris: [callbackUrl],
					token_endpoint_auth_method: "none",
				},
				{ status: 201 },
			);
		if (url.href === `${issuer}/token`) {
			tokenRequests++;
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("client_id")).toBe("fixture-client");
			if (body.get("grant_type") === "authorization_code") {
				expect(body.get("redirect_uri")).toBe(callbackUrl);
				expect(
					createHash("sha256")
						.update(defined(body.get("code_verifier")))
						.digest("base64url"),
				).toBe(redirect?.searchParams.get("code_challenge"));
			} else expect(body.get("refresh_token")).toBe("fixture-refresh");
			return Response.json({
				access_token: `fixture-access-${tokenRequests}`,
				token_type: "Bearer",
				expires_in: 3600,
				...(tokenRequests === 1 ? { refresh_token: "fixture-refresh" } : {}),
			});
		}
		return new Response("Not found", { status: 404 });
	};
	return {
		server,
		issuer,
		request,
		provider,
		saved: () => saved,
		redirect: () => redirect,
		setRedirect: (value: string) => {
			redirect = new URL(value);
		},
		tokenRequests: () => tokenRequests,
		expire: () => {
			saved.expiresAt = Date.now() - 1;
		},
	};
}
