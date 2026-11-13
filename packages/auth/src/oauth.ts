import { AsyncLocalStorage } from "node:async_hooks";
import { cimd } from "@better-auth/cimd";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { BodyReadError, boundedRequest } from "@toolstile/gateway/request-body";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { fetchClientMetadataResource } from "./client-metadata";
import { digest } from "./digest";

/** An application authorization, never an OAuth client shared by many agents. */
export interface AgentOAuthOptions {
	resource: string;
	selection(input: {
		userId: string;
		sessionId: string;
		flowKey: string;
	}): Promise<string | undefined>;
	validateAuthorization(userId: string, referenceId: string): Promise<void>;
}

const oauthRequest = new AsyncLocalStorage<URLSearchParams>();
export function oauthFlowKey(query: URLSearchParams): string {
	const identity = ["client_id", "redirect_uri", "code_challenge", "state"].map(
		(key) => [key, query.get(key)],
	);
	if (
		!query.get("client_id") ||
		!query.get("redirect_uri") ||
		!query.get("code_challenge")
	)
		throw new Error("An authorization-code request with PKCE is required");
	return digest(JSON.stringify(identity));
}

export async function validatedOAuthFlow(query: string, secret: string) {
	if (!(await verifyOAuthQueryParams(query, secret)))
		throw new Error("Authorization request is invalid or expired");
	return oauthFlowKey(new URLSearchParams(query));
}

/** Preserve each browser flow independently, including concurrent browser tabs.
 * A JSON body is read once within size and time limits; `next` receives that
 * buffered request, and an oversized or stalled body ends with 413/408. */
export async function withOAuthRequest(
	request: Request,
	next: (request: Request) => Promise<Response>,
) {
	let query = new URL(request.url).searchParams;
	let current = request;
	if (
		request.method === "POST" &&
		request.headers.get("content-type")?.includes("application/json")
	) {
		try {
			current = await boundedRequest(request, {
				maximum: 1024 * 1024,
				timeoutMs: 10_000,
			});
		} catch (error) {
			if (!(error instanceof BodyReadError)) throw error;
			return Response.json(
				{ message: error.message },
				{ status: error.status, headers: { "Cache-Control": "no-store" } },
			);
		}
		const body = await current
			.clone()
			.json()
			.catch(() => null);
		if (
			body &&
			typeof body === "object" &&
			"oauth_query" in body &&
			typeof body.oauth_query === "string"
		)
			query = new URLSearchParams(body.oauth_query);
	}
	return oauthRequest.run(query, () => next(current));
}

export function agentOAuthPlugins(options: AgentOAuthOptions) {
	async function validate(userId: string, referenceId: string) {
		try {
			await options.validateAuthorization(userId, referenceId);
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"status" in error &&
				error.status === 403
			)
				throw new APIError("BAD_REQUEST", {
					error: "invalid_grant",
					error_description: "Agent authorization is no longer available",
				});
			throw error;
		}
	}
	async function selection(userId: string, sessionId: string) {
		const query = oauthRequest.getStore();
		if (!query) return;
		let flowKey: string;
		try {
			flowKey = oauthFlowKey(query);
		} catch {
			return;
		}
		return options.selection({ userId, sessionId, flowKey });
	}
	const provider = mcp({
		resource: options.resource,
		loginPage: "/authorize-agent",
		consentPage: "/consent-agent",
		scopes: ["openid", "profile", "offline_access", "mcp:access"],
		allowDynamicClientRegistration: true,
		allowUnauthenticatedClientRegistration: true,
		clientRegistrationDefaultApplicationType: "infer",
		postLogin: {
			page: "/authorize-agent",
			shouldRedirect: async ({ user, session }) =>
				!(await selection(user.id, session.id)),
			consentReferenceId: async ({ user, session }) => {
				const reference = await selection(user.id, session.id);
				if (!reference) throw new Error("Select an agent authorization first");
				await validate(user.id, reference);
				return reference;
			},
		},
		customAccessTokenClaims: async ({ user, referenceId }) => {
			if (!user || !referenceId)
				throw new Error("Agent authorization is required");
			await validate(user.id, referenceId);
			return { toolstile_authorization: referenceId };
		},
	});
	// RFC 9728 §3: the suffix-less document describes the origin, which is not a protected resource.
	const rootMetadata = new URL(options.resource).pathname.replace(/\/+$/, "")
		? "/.well-known/oauth-protected-resource"
		: undefined;
	const serveMetadata = provider.onRequest;
	return [
		jwt(),
		{
			...provider,
			onRequest: async (
				request: Request,
				context: Parameters<typeof serveMetadata>[1],
			) => {
				if (new URL(request.url).pathname.replace(/\/+$/, "") !== rootMetadata)
					return serveMetadata(request, context);
			},
		},
		cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
	];
}

export { requireMcpAuth };
