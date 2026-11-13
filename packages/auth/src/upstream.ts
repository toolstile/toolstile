import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ORPCError } from "@orpc/server";
import type { ConnectionStatus } from "@toolstile/database/connection-status";
import type { Pool, PoolClient } from "@toolstile/database/sql";
import {
	transaction as inTransaction,
	type Transaction,
} from "@toolstile/database/transaction";
import {
	authorizeUpstream,
	fetchWithoutRedirects,
	OAuthError,
	type UpstreamOAuthData,
	UpstreamOAuthProvider,
	UpstreamReconnectRequired,
} from "@toolstile/gateway";
import { digest as hash } from "./digest";
import { destinationRefused, failureReason } from "./failure";
import {
	createGrantCoordinator,
	markGrantReconnect,
} from "./upstream-coordination";

type Owner = {
	userId: string;
	sessionId: string;
};
type Box = {
	encrypt(value: unknown): string;
	decrypt<T>(value: string): T;
};
export interface UpstreamOAuthServiceOptions<Context> {
	pool: Pool;
	box: Box;
	baseURL: string;
	validateDestination(url: URL): Promise<void>;
	fetch?: typeof fetch;
	/**
	 * Trusted operator configuration for the exact upstream HTTPS origin. `required` marks a
	 * provider without dynamic registration; `client` is present once the operator configured one.
	 */
	registeredClient?(origin: string): Promise<
		| {
				required: boolean;
				client?: {
					clientId: string;
					clientSecret?: string;
					issuer?: string;
				};
		  }
		| undefined
	>;
	authorize(
		owner: Owner,
		connectionId: string,
		context: Context,
	): Promise<{
		url: string;
	}>;
	saveContext(
		client: Transaction,
		flowId: string,
		context: Context,
	): Promise<void>;
	loadContext(
		client: Pick<Transaction, "query">,
		flowId: string,
	): Promise<Context>;
}
/** Token-endpoint refusals that no retry can fix: the grant or client must be set up again. */
const permanentOAuthErrors = [
	"invalid_grant",
	"invalid_client",
	"unauthorized_client",
	"access_denied",
	"invalid_token",
	"invalid_scope",
];
const transaction = <T>(pool: Pool, work: (tx: Transaction) => Promise<T>) =>
	inTransaction(pool, work);
/** Common OAuth mechanics. Application ownership and additional context stay in adapters. */
export function createUpstreamOAuthService<Context>(
	options: UpstreamOAuthServiceOptions<Context>,
) {
	const callbackUrl = `${options.baseURL}/oauth/upstream/callback`;
	const origin = new URL(options.baseURL);
	const clientMetadataUrl =
		origin.protocol === "https:" &&
		!isIP(origin.hostname) &&
		!origin.hostname.endsWith(".local") &&
		!origin.hostname.endsWith(".localhost") &&
		origin.hostname !== "localhost"
			? `${options.baseURL}/oauth/client-metadata.json`
			: undefined;
	const guardedFetch: typeof fetch = async (input, init) => {
		await options.validateDestination(
			new URL(input instanceof Request ? input.url : String(input)),
		);
		const timeout = AbortSignal.timeout(15000);
		return fetchWithoutRedirects(options.fetch ?? fetch, input, {
			...init,
			signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		});
	};
	async function read(
		client: Pick<PoolClient, "query">,
		connectionId: string,
	): Promise<UpstreamOAuthData> {
		const result = await client.query(
			'select g."encryptedData" from connection_oauth c join upstream_oauth_grants g on g.id=c."grantId" where c."connectionId"=$1',
			[connectionId],
		);
		return result.rows[0]
			? options.box.decrypt<UpstreamOAuthData>(result.rows[0].encryptedData)
			: { version: 1 };
	}
	async function replace(
		client: Transaction,
		connectionId: string,
		data: UpstreamOAuthData,
	) {
		const grantId = randomUUID();
		await client.query(
			'insert into upstream_oauth_grants(id,"encryptedData") values($1,$2)',
			[grantId, options.box.encrypt(data)],
		);
		await client.query(
			'insert into connection_oauth("connectionId","grantId") values($1,$2) on conflict ("connectionId") do update set "grantId"=excluded."grantId"',
			[connectionId, grantId],
		);
	}
	const coordinateGrant = createGrantCoordinator(options.pool);
	/**
	 * Marks the connections still using the grant that failed. A connection with no grant was
	 * never signed in and keeps its status; one signed in again since holds a new grant and is
	 * left alone, so a late failure cannot undo a fresh sign-in.
	 */
	async function needsReconnection(grantId?: string): Promise<never> {
		if (grantId) await markGrantReconnect(options.pool, grantId);
		throw new UpstreamReconnectRequired();
	}
	return {
		metadata() {
			return {
				client_id: `${options.baseURL}/oauth/client-metadata.json`,
				client_name: "Toolstile",
				redirect_uris: [callbackUrl],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			};
		},
		async begin(
			owner: Owner,
			connectionId: string,
			context: Context,
			input: {
				clientId?: string;
				clientSecret?: string;
				confirmAccountReplacement?: boolean;
			} = {},
		) {
			await options.pool.query(
				'delete from upstream_oauth_flows where "expiresAt" < clock_timestamp()',
			);
			const connection = await options.authorize(owner, connectionId, context);
			await options.validateDestination(new URL(connection.url));
			const previous = await read(options.pool, connectionId);
			if (previous.tokens && !input.confirmAccountReplacement)
				throw new Error(
					"Confirm replacement of this account's authentication before reconnecting",
				);
			const data: UpstreamOAuthData = { version: 1, client: previous.client };
			const operator =
				!data.client && !input.clientId
					? await options.registeredClient?.(new URL(connection.url).origin)
					: undefined;
			const registered = operator?.client;
			if (!data.client && !input.clientId && registered)
				data.client = {
					client_id: registered.clientId,
					...(registered.issuer ? { issuer: registered.issuer } : {}),
					...(registered.clientSecret
						? {
								client_secret: registered.clientSecret,
								token_endpoint_auth_method: "client_secret_post",
							}
						: { token_endpoint_auth_method: "none" }),
				};
			if (input.clientId)
				data.client = {
					client_id: input.clientId,
					...(input.clientSecret
						? {
								client_secret: input.clientSecret,
								token_endpoint_auth_method: "client_secret_post",
							}
						: { token_endpoint_auth_method: "none" }),
				};
			if (!data.client && operator?.required)
				throw new ORPCError("PRECONDITION_FAILED", {
					message:
						"This provider's browser sign-in requires a registered OAuth application. Ask your administrator to configure it, enter your registered client settings, or connect using an access token.",
				});
			const state = randomBytes(32).toString("base64url"),
				id = hash(state);
			await transaction(options.pool, async (client) => {
				await client.query(
					'insert into upstream_oauth_flows(id,"connectionId","userId","sessionId","serverUrl","encryptedData","expiresAt") values($1,$2,$3,$4,$5,$6,$7)',
					[
						id,
						connectionId,
						owner.userId,
						owner.sessionId,
						connection.url,
						options.box.encrypt(data),
						new Date(Date.now() + 600000),
					],
				);
				await options.saveContext(client, id, context);
			});
			let authorizationUrl: string | undefined;
			const provider = new UpstreamOAuthProvider({
				callbackUrl,
				clientMetadataUrl: data.client ? undefined : clientMetadataUrl,
				state,
				data,
				save: async (next) => {
					await options.pool.query(
						'update upstream_oauth_flows set "encryptedData"=$2 where id=$1 and "consumedAt" is null',
						[id, options.box.encrypt(next)],
					);
				},
				redirect: async (url) => {
					await options.validateDestination(url);
					authorizationUrl = url.href;
				},
			});
			try {
				const result = await authorizeUpstream(provider, {
					serverUrl: connection.url,
					fetchFn: guardedFetch,
					forceReauthorization: true,
				});
				if (result !== "REDIRECT" || !authorizationUrl)
					throw new Error("No authorization URL returned");
				return { url: authorizationUrl };
			} catch (error) {
				console.warn("MCP sign-in could not start", failureReason(error));
				await options.pool.query(
					'update upstream_oauth_flows set "consumedAt"=clock_timestamp(),"encryptedData"=$2 where id=$1',
					[id, options.box.encrypt({ version: 1 })],
				);
				throw new ORPCError("BAD_GATEWAY", {
					message:
						"Could not start MCP sign-in. Check its OAuth support and registered client settings, or try again if the provider is temporarily unavailable.",
				});
			}
		},
		async finish(owner: Owner, state: string, code?: string, issuer?: string) {
			if (!state || state.length > 256)
				throw new Error("Authorization request is invalid or expired");
			const id = hash(state);
			const { flow, context } = await transaction(
				options.pool,
				async (client) => {
					const result = await client.query<{
						connectionId: string;
						serverUrl: string;
						encryptedData: string;
					}>(
						'select "connectionId","serverUrl","encryptedData" from upstream_oauth_flows where id=$1 and "userId"=$2 and "sessionId"=$3 and "consumedAt" is null and "expiresAt">clock_timestamp() for update',
						[id, owner.userId, owner.sessionId],
					);
					if (!result.rows[0])
						throw new Error("Authorization request is invalid or expired");
					const flow: {
						connectionId: string;
						serverUrl: string;
						encryptedData: string;
					} = result.rows[0];
					const context = await options.loadContext(client, id);
					// The row lock claims the flow: a concurrent callback waits, then finds it
					// consumed. The persisted PKCE verifier is erased in the same transaction.
					await client.query(
						'update upstream_oauth_flows set "consumedAt"=clock_timestamp(),"encryptedData"=$2 where id=$1',
						[id, options.box.encrypt({ version: 1 })],
					);
					return { flow, context };
				},
			);
			if (!code) throw new Error("MCP sign-in was cancelled");
			const connection = await options.authorize(
				owner,
				flow.connectionId,
				context,
			);
			if (connection.url !== flow.serverUrl)
				throw new Error("MCP configuration changed; start sign-in again");
			await options.validateDestination(new URL(connection.url));
			const provider = new UpstreamOAuthProvider({
				callbackUrl,
				state,
				data: options.box.decrypt<UpstreamOAuthData>(flow.encryptedData),
				save: async () => {},
				redirect: async () => {
					throw new UpstreamReconnectRequired();
				},
			});
			try {
				const result = await authorizeUpstream(provider, {
					serverUrl: connection.url,
					fetchFn: guardedFetch,
					authorizationCode: code,
					iss: issuer,
				});
				if (result !== "AUTHORIZED" || !provider.tokens())
					throw new Error("No tokens returned");
				await transaction(options.pool, async (client) => {
					const current = await client.query<{ url: string }>(
						"select url from connections where id=$1",
						[flow.connectionId],
					);
					if (current.rows[0]?.url !== flow.serverUrl)
						throw new Error("MCP configuration changed; reconnect");
					await replace(client, flow.connectionId, provider.snapshot);
					await client.query(
						"update connections set authentication=$2,status=$3 where id=$1",
						[
							flow.connectionId,
							"oauth",
							"authenticated" satisfies ConnectionStatus,
						],
					);
				});
				await options.pool.query(
					'delete from upstream_oauth_grants AS g where not exists (select 1 from connection_oauth c where c."grantId"=g.id)',
				);
				// The dashboard highlights the signed-in connection; its id is not a credential.
				return { connectionId: flow.connectionId, context };
			} catch (error) {
				console.warn("MCP sign-in could not complete", failureReason(error));
				throw new Error(
					"MCP sign-in could not be completed. Start sign-in again.",
				);
			}
		},
		runtimeProvider(connectionId: string, serverUrl: string) {
			let issuedToken: string | undefined;
			async function token(refresh = false) {
				// Permanent outcomes win over a temporary failure seen earlier in the same attempt.
				let temporaryFailure = false,
					permanentFailure = false;
				let beginExchange: (() => Promise<void>) | undefined;
				let leasedGrant: string | undefined;
				const refreshFetch: typeof fetch = async (input, init) => {
					try {
						const method = (
							init?.method ?? (input instanceof Request ? input.method : "GET")
						).toUpperCase();
						if (method === "POST") {
							const body =
								init?.body ??
								(input instanceof Request
									? await input.clone().text()
									: undefined);
							if (
								new URLSearchParams(
									typeof body === "string" || body instanceof URLSearchParams
										? body
										: "",
								).get("grant_type") === "refresh_token"
							) {
								if (!beginExchange)
									throw new Error("Refresh exchange has no durable owner");
								await beginExchange();
							}
						}
						const response = await guardedFetch(input, init);
						if (response.status >= 500 || response.status === 429)
							temporaryFailure = true;
						else if (
							(response.status === 400 || response.status === 401) &&
							(init?.method ?? "GET").toUpperCase() === "POST"
						) {
							// The SDK turns invalid_grant into a fresh authorization attempt, so the
							// token endpoint's own answer is the reliable signal.
							const body: unknown = await response
								.clone()
								.json()
								.catch(() => undefined);
							const code =
								body && typeof body === "object" && "error" in body
									? body.error
									: undefined;
							if (
								typeof code === "string" &&
								permanentOAuthErrors.includes(code)
							)
								permanentFailure = true;
						}
						return response;
					} catch (error) {
						// A policy refusal repeats on every retry; only network failures are temporary.
						if (destinationRefused(error)) {
							console.warn(
								"MCP token refresh refused by network settings; reconnection required",
							);
							permanentFailure = true;
						} else temporaryFailure = true;
						throw error;
					}
				};
				try {
					return await coordinateGrant(connectionId, async (lease) => {
						leasedGrant = lease.grantId;
						const client = options.pool;
						const status = await client.query(
							"select status from connections where id=$1",
							[connectionId],
						);
						if (
							!status.rows[0] ||
							status.rows[0].status === "needs reconnection"
						)
							throw new UpstreamReconnectRequired();
						const data = options.box.decrypt<UpstreamOAuthData>(
							lease.encryptedData,
						);
						if (!data.tokens) throw new UpstreamReconnectRequired();
						const stale =
							data.expiresAt !== undefined &&
							data.expiresAt <= Date.now() + 30000;
						if (
							stale ||
							(refresh && issuedToken === data.tokens.access_token)
						) {
							if (!data.tokens.refresh_token)
								throw new UpstreamReconnectRequired();
							const provider = new UpstreamOAuthProvider({
								callbackUrl,
								state: "",
								data,
								save: async () => {},
								redirect: async () => {
									throw new UpstreamReconnectRequired();
								},
							});
							beginExchange = lease.beginRefresh;
							await authorizeUpstream(provider, {
								serverUrl,
								fetchFn: refreshFetch,
							});
							await lease.persist(options.box.encrypt(provider.snapshot));
							data.tokens = provider.tokens();
						}
						if (data.tokens?.token_type.toLowerCase() !== "bearer")
							throw new UpstreamReconnectRequired();
						issuedToken = data.tokens.access_token;
						return issuedToken;
					});
				} catch (error) {
					if (error instanceof UpstreamReconnectRequired)
						return needsReconnection(leasedGrant);
					if (permanentFailure) return needsReconnection(leasedGrant);
					if (temporaryFailure)
						throw new Error(
							"MCP authentication is temporarily unavailable. Retry the request.",
						);
					if (
						error instanceof UpstreamReconnectRequired ||
						(error instanceof OAuthError &&
							permanentOAuthErrors.includes(error.code))
					)
						return needsReconnection(leasedGrant);
					throw new Error(
						"MCP authentication is temporarily unavailable. Retry the request.",
					);
				}
			}
			return {
				token: () => token(),
				onUnauthorized: async () => {
					await token(true);
				},
			};
		},
		async cleanupUnusedGrants() {
			await options.pool.query(
				'delete from upstream_oauth_grants AS g where not exists (select 1 from connection_oauth c where c."grantId"=g.id)',
			);
		},
	};
}
