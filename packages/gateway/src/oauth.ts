import type {
	OAuthClientInformationContext,
	OAuthClientProvider,
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/** Persist encrypted by the application; never send this object to a browser. */
export interface UpstreamOAuthData {
	version: 1;
	client?: StoredOAuthClientInformation;
	tokens?: StoredOAuthTokens;
	expiresAt?: number;
	verifier?: string;
	discovery?: OAuthDiscoveryState;
}
export class UpstreamReconnectRequired extends Error {
	constructor() {
		super("Reconnect this MCP account before using it again");
		this.name = "UpstreamReconnectRequired";
	}
}

export interface UpstreamOAuthOptions {
	callbackUrl: string;
	clientMetadataUrl?: string;
	state: string;
	data: UpstreamOAuthData;
	save(data: UpstreamOAuthData): Promise<void>;
	redirect(url: URL): Promise<void>;
}

/** The SDK owns discovery, PKCE, issuer binding, registration and token exchange. */
export class UpstreamOAuthProvider implements OAuthClientProvider {
	private data: UpstreamOAuthData;
	readonly clientMetadataUrl?: string;
	constructor(private options: UpstreamOAuthOptions) {
		this.data = structuredClone(options.data);
		this.clientMetadataUrl = options.clientMetadataUrl;
	}
	get redirectUrl() {
		return this.options.callbackUrl;
	}
	get clientMetadata() {
		return {
			client_name: "Toolstile",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none" as const,
		};
	}
	state() {
		return this.options.state;
	}
	async clientInformation(context?: OAuthClientInformationContext) {
		if (context && this.data.client && !this.data.client.issuer) {
			this.data.client = { ...this.data.client, issuer: context.issuer };
			await this.persist();
		}
		return context &&
			this.data.client?.issuer &&
			context.issuer !== this.data.client.issuer
			? undefined
			: this.data.client;
	}
	tokens(context?: OAuthClientInformationContext) {
		return context &&
			this.data.tokens?.issuer &&
			context.issuer !== this.data.tokens.issuer
			? undefined
			: this.data.tokens;
	}
	get snapshot() {
		return structuredClone(this.data);
	}
	private async persist() {
		await this.options.save(this.snapshot);
	}
	async saveClientInformation(client: StoredOAuthClientInformation) {
		this.data.client = client;
		await this.persist();
	}
	async saveTokens(tokens: StoredOAuthTokens) {
		const previous = this.data.tokens;
		this.data.tokens = {
			...tokens,
			...(tokens.refresh_token ||
			!previous?.refresh_token ||
			previous.issuer !== tokens.issuer
				? {}
				: { refresh_token: previous.refresh_token }),
		};
		this.data.expiresAt =
			tokens.expires_in === undefined
				? undefined
				: Date.now() + tokens.expires_in * 1000;
		delete this.data.verifier;
		await this.persist();
	}
	async redirectToAuthorization(url: URL) {
		await this.options.redirect(url);
	}
	async saveCodeVerifier(verifier: string) {
		this.data.verifier = verifier;
		await this.persist();
	}
	codeVerifier() {
		if (!this.data.verifier)
			throw new Error("Authorization attempt expired; reconnect this account");
		return this.data.verifier;
	}
	async saveDiscoveryState(discovery: OAuthDiscoveryState) {
		this.data.discovery = discovery;
		await this.persist();
	}
	discoveryState() {
		return this.data.discovery;
	}
	async invalidateCredentials(
		scope: "all" | "client" | "tokens" | "verifier" | "discovery",
	) {
		if (scope === "all") this.data = { version: 1 };
		else if (scope === "client") delete this.data.client;
		else if (scope === "tokens") {
			delete this.data.tokens;
			delete this.data.expiresAt;
		} else if (scope === "verifier") delete this.data.verifier;
		else delete this.data.discovery;
		await this.persist();
	}
}

export {
	auth as authorizeUpstream,
	OAuthError,
} from "@modelcontextprotocol/client";
