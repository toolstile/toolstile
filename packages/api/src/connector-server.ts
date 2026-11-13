import { createHmac } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
import { ConnectorRequestConflict } from "@toolstile/database/connector-catalog";
import { z } from "zod";
import {
	type CatalogSource,
	catalogLogoUrl,
	matchCatalogEntry,
} from "./catalog-source.js";
import {
	catalogSlug,
	connectorCatalogEntry,
	connectorInventory,
	connectorStarter,
	httpsUrl,
} from "./connectors.js";
import {
	type Actor,
	type ConnectConnectorInput,
	type ConnectionPreview,
	connectConnectorInput,
	connectionCreatedView,
	connectionPreviewInput,
	connectionPreviewView,
} from "./contract.js";

/**
 * The idempotency record for one confirmed connection: `connector_requests` is keyed by owner,
 * scope and `requestId`, and `fingerprint` binds the confirmed URL, authentication, transport
 * and headers. `suggestionId` is the catalog entry the URL still display-matches, or null.
 */
export type ConnectorRequest = {
	requestId: string;
	fingerprint: string;
	suggestionId: string | null;
};

export function createConnectorService(options: {
	source: Pick<CatalogSource, "read">;
	key: string;
	authorize(actor: Actor): Promise<unknown>;
	/** Destination policy, then `detectServerAddress` (with the `/mcp` and `/sse` probes); saves nothing. */
	preview(actor: Actor, url: string): Promise<ConnectionPreview>;
	/** Destination policy and a real check of exactly `input.url`, then the idempotent insert. */
	create(
		actor: Actor,
		input: ConnectConnectorInput,
		request: ConnectorRequest,
	): Promise<z.infer<typeof connectionCreatedView>>;
}) {
	async function catalog(actor: Actor) {
		await options.authorize(actor);
		return (await options.source.read()).entries;
	}
	/**
	 * Fingerprints the confirmed request. The catalog is read only to keep the display hint
	 * when the URL still matches that entry; it never changes, gates or fails the request.
	 */
	async function prepare(actor: Actor, input: ConnectConnectorInput) {
		await options.authorize(actor);
		const headers = Object.fromEntries(
			Object.entries(input.headers).sort(([a], [b]) => a.localeCompare(b)),
		);
		const fingerprint = createHmac("sha256", options.key)
			.update("connector-request:")
			.update(
				JSON.stringify({
					url: input.url,
					authentication: input.authentication,
					transport: input.transport ?? null,
					headers,
				}),
			)
			.digest("hex");
		let suggestionId: string | null = null;
		if (input.suggestionId)
			try {
				const { entries } = await options.source.read();
				if (matchCatalogEntry(entries, input.url)?.slug === input.suggestionId)
					suggestionId = input.suggestionId;
			} catch {}
		return {
			input,
			request: { requestId: input.requestId, fingerprint, suggestionId },
		};
	}
	return {
		catalog,
		prepare,
		async preview(actor: Actor, url: string) {
			await options.authorize(actor);
			return options.preview(actor, url);
		},
		async inventory(actor: Actor, slug: string) {
			return (
				(await catalog(actor)).find((entry) => entry.slug === slug)
					?.toolSnapshot ?? null
			);
		},
		async connect(actor: Actor, input: ConnectConnectorInput) {
			const prepared = await prepare(actor, input);
			return options.create(actor, prepared.input, prepared.request);
		},
	};
}
export function createConnectorRouter(
	service: ReturnType<typeof createConnectorService>,
) {
	const procedure = os.$context<{ actor: Actor }>();
	return {
		// Tool snapshots can be long; the details view loads one at a time.
		connectorCatalog: procedure
			.output(z.array(connectorCatalogEntry))
			.handler(async ({ context }) =>
				(await service.catalog(context.actor)).map(
					({ listed: _, toolSnapshot: __, logo, ...entry }) => ({
						...entry,
						logoUrl: catalogLogoUrl({ slug: entry.slug, logo }),
					}),
				),
			),
		connectorInventory: procedure
			.input(z.object({ connectorId: catalogSlug }))
			.output(connectorInventory.nullable())
			.handler(({ context, input }) =>
				service.inventory(context.actor, input.connectorId),
			),
		// Reviewed starters for the catalog entry a connection's URL display-matches.
		connectorStarters: procedure
			.input(
				z.object({
					/** Accepted from older dashboards and ignored: starters follow the URL. */
					connectorId: z.string().max(64).nullable().optional(),
					url: z.string().max(2048),
				}),
			)
			.output(z.array(connectorStarter))
			.handler(
				async ({ context, input }) =>
					matchCatalogEntry(await service.catalog(context.actor), input.url)
						?.starters ?? [],
			),
		previewConnection: procedure
			.input(connectionPreviewInput)
			.output(connectionPreviewView)
			.handler(({ context, input }) =>
				service.preview(context.actor, input.url),
			),
		connectConnector: procedure
			.input(connectConnectorInput)
			.output(connectionCreatedView)
			.handler(({ context, input }) => service.connect(context.actor, input)),
	};
}
export type ConnectorRouter = ReturnType<typeof createConnectorRouter>;

export function connectorRequestError(error: unknown): never {
	if (error instanceof ConnectorRequestConflict)
		throw new ORPCError("CONFLICT", { message: error.message });
	throw error;
}
/** The error for a confirmed address that did not pass its check; nothing is saved. */
export function connectionCheckFailed() {
	return new ORPCError("BAD_GATEWAY", {
		message:
			"Toolstile could not connect to an MCP server at this exact address with these settings. Check the address and sign-in method, then try again.",
	});
}

const upstreamOAuthClient = z.strictObject({
	/** An exact HTTPS origin, as `new URL(...).origin` writes it. */
	origin: z
		.string()
		.refine(
			(value) =>
				value.startsWith("https://") && URL.parse(value)?.origin === value,
			"Use an exact https:// origin",
		),
	env: z.string().regex(/^[A-Z][A-Z0-9_]{0,40}$/),
	issuer: httpsUrl.optional(),
});
const upstreamOAuthClientList = z
	.array(upstreamOAuthClient)
	.max(100)
	.refine(
		(clients) =>
			new Set(clients.map((client) => client.origin)).size === clients.length,
		"Two clients share one origin",
	);
export type UpstreamOAuthClientConfig = z.infer<typeof upstreamOAuthClient>;
/** Used when `UPSTREAM_OAUTH_CLIENTS` is unset: GitHub's MCP server has no dynamic registration. */
export const defaultUpstreamOAuthClients: UpstreamOAuthClientConfig[] = [
	{
		origin: "https://api.githubcopilot.com",
		env: "GITHUB_MCP",
		issuer: "https://github.com/login/oauth",
	},
];
/**
 * Operator OAuth clients for servers without dynamic client registration, from the
 * `UPSTREAM_OAUTH_CLIENTS` JSON list of `{origin, env, issuer}`; never from the public catalog.
 * An invalid value fails every OAuth start that consults it rather than being ignored.
 */
export function upstreamOAuthClients(value: string | undefined) {
	if (!value?.trim()) return defaultUpstreamOAuthClients;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("UPSTREAM_OAUTH_CLIENTS is not valid JSON");
	}
	const result = upstreamOAuthClientList.safeParse(parsed);
	if (!result.success)
		throw new Error(
			`UPSTREAM_OAUTH_CLIENTS must be a JSON list of {origin, env, issuer}: ${result.error.issues[0]?.message ?? "invalid"}`,
		);
	return result.data;
}
/**
 * The operator client for an exact upstream origin. `required` marks a configured origin; the
 * client comes from the server environment as `${env}_CLIENT_ID` and `${env}_CLIENT_SECRET`.
 */
export function registeredClientFor(
	origin: string,
	environment: Record<string, string | undefined> = process.env,
) {
	const entry = upstreamOAuthClients(environment.UPSTREAM_OAUTH_CLIENTS).find(
		(item) => item.origin === origin,
	);
	if (!entry) return;
	const clientId = environment[`${entry.env}_CLIENT_ID`];
	const clientSecret = environment[`${entry.env}_CLIENT_SECRET`];
	if (!clientId || !clientSecret) return { required: true };
	return {
		required: true,
		client: {
			clientId,
			clientSecret,
			...(entry.issuer ? { issuer: entry.issuer } : {}),
		},
	};
}

/** Catalog logos for connection views, display-matched by URL against the catalog source. */
export async function connectionLogos<T extends { url: string }>(
	source: Pick<CatalogSource, "read">,
	connections: T[],
) {
	if (!connections.length) return [];
	const { entries } = await source.read();
	return connections.map((item) => ({
		...item,
		logoUrl: catalogLogoUrl(matchCatalogEntry(entries, item.url)),
	}));
}
