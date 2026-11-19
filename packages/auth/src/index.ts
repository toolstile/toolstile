import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { cliDevicePlugins } from "./cli";
import { type AgentOAuthOptions, agentOAuthPlugins } from "./oauth";
import {
	type SessionIssuanceOptions,
	sessionIssuanceGuard,
} from "./session-issuance";

// Control and format characters (bidi overrides, zero-width marks) can disguise a display name.
const hiddenNameCharacters = /[\p{Cc}\p{Cf}]/gu;
function displayName<T>(value: T): T {
	if (typeof value !== "string") return value;
	const name = value.replace(hiddenNameCharacters, "").trim();
	if (!name) throw new APIError("BAD_REQUEST", { message: "Enter your name." });
	if (name.length > 100)
		throw new APIError("BAD_REQUEST", {
			message: "Use a name of 100 characters or fewer.",
		});
	return name as T;
}

export * from "./cli";
export { digest } from "./digest";
export * from "./email";
export * from "./oauth";
export * from "./upstream";
export const issueToken = () => `ts_${randomBytes(32).toString("base64url")}`;
export function secretBox(hexKey: string) {
	if (!/^[a-f0-9]{64}$/i.test(hexKey))
		throw new Error("ENCRYPTION_KEY must be 32 random bytes encoded as hex");
	const key = Buffer.from(hexKey, "hex");
	return {
		encrypt(value: unknown): string {
			const iv = randomBytes(12),
				cipher = createCipheriv("aes-256-gcm", key, iv);
			const encrypted = Buffer.concat([
				cipher.update(JSON.stringify(value), "utf8"),
				cipher.final(),
			]);
			return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
				"base64url",
			);
		},
		decrypt<T = Record<string, string>>(value: string): T {
			// Layout: 12-byte IV, 16-byte tag (encrypt's GCM default), then ciphertext. A pinned tag
			// length refuses truncated tags that GCM would otherwise accept.
			const data = Buffer.from(value, "base64url");
			if (data.length < 28) throw new Error("Encrypted value is malformed");
			const cipher = createDecipheriv(
				"aes-256-gcm",
				key,
				data.subarray(0, 12),
				{ authTagLength: 16 },
			);
			cipher.setAuthTag(data.subarray(12, 28));
			return JSON.parse(
				Buffer.concat([
					cipher.update(data.subarray(28)),
					cipher.final(),
				]).toString("utf8"),
			);
		},
	};
}
function withoutIdToken<
	T extends {
		idToken?: string | null;
	},
>(data: T): T {
	return "idToken" in data ? { ...data, idToken: null } : data;
}
/** Let unexpected library failures reach this boundary instead of better-call's raw console fallback. */
export function safeAuth<
	T extends { handler: (request: Request) => Promise<Response> },
>(auth: T): T {
	const handler = auth.handler.bind(auth);
	return Object.assign(auth, {
		async handler(request: Request) {
			try {
				return await handler(request);
			} catch {
				console.error("Authentication request failed");
				return Response.json(
					{
						code: "INTERNAL_SERVER_ERROR",
						message: "Authentication operation failed",
					},
					{ status: 500, headers: { "Cache-Control": "no-store" } },
				);
			}
		},
	});
}
export const SESSION_FRESH_AGE_SECONDS = 600;
/**
 * Library endpoints no screen, command or agent flow uses. They are disabled rather than wrapped:
 * each would change credentials, sessions, identity or OAuth clients outside the application's
 * fenced transactions (password and email changes, session listing and revocation, account
 * linking and deletion, password reset, OAuth client and consent administration, and device code
 * lookup, approval and denial, which `/api/cli/lookup`, `/approve` and `/deny` make instead).
 */
export const UNUSED_AUTH_PATHS = [
	"/account-info",
	"/change-email",
	"/change-password",
	"/delete-user",
	"/delete-user/callback",
	"/device",
	"/device/approve",
	"/device/deny",
	"/get-access-token",
	"/link-social",
	"/list-accounts",
	"/list-sessions",
	"/refresh-token",
	"/request-password-reset",
	"/reset-password",
	"/reset-password/:token",
	"/revoke-other-sessions",
	"/revoke-session",
	"/revoke-sessions",
	"/send-verification-email",
	"/unlink-account",
	"/update-session",
	"/update-user",
	"/verify-password",
	"/oauth2/client/rotate-keys",
	"/oauth2/client/rotate-secret",
	"/oauth2/create-client",
	"/oauth2/delete-client",
	"/oauth2/delete-consent",
	"/oauth2/get-client",
	"/oauth2/get-clients",
	"/oauth2/get-consent",
	"/oauth2/get-consents",
	"/oauth2/update-client",
	"/oauth2/update-consent",
];
export function createAuth(options: {
	database: Parameters<typeof drizzleAdapter>[0];
	schema: Record<string, unknown>;
	baseURL: string;
	cookiePrefix?: string;
	socialProviders?: Partial<
		Record<
			"github" | "google",
			{
				clientId: string;
				clientSecret: string;
			}
		>
	>;
	secret: string;
	canRegister: (
		email: string,
		identity?: {
			invitationToken?: string;
			verified: boolean;
		},
	) => Promise<boolean>;
	canSignIn?: (userId: string) => Promise<void>;
	/** Orders session issuance with the host's session-revoking account changes. */
	sessionIssuance?: SessionIssuanceOptions;
	sendVerificationEmail?: (data: {
		user: {
			id: string;
			email: string;
		};
		url: string;
		token: string;
	}) => Promise<void>;
	oauth?: AgentOAuthOptions;
	/** CLI sign-in through device authorization; see cliDevicePlugins. */
	cliDevices?: Parameters<typeof cliDevicePlugins>[0];
}) {
	if (options.secret.length < 32)
		throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
	if (/replace|change-me|changeme/i.test(options.secret))
		throw new Error(
			"BETTER_AUTH_SECRET is still an example placeholder; generate a random value",
		);
	const issuance = options.sessionIssuance
		? sessionIssuanceGuard(options.sessionIssuance)
		: undefined;
	return safeAuth(
		betterAuth({
			database: drizzleAdapter(options.database, {
				provider: "pg",
				schema: options.schema,
			}),
			onAPIError: { throw: true },
			disabledPaths: UNUSED_AUTH_PATHS,
			// Library errors may contain SQL parameters or provider response bodies.
			logger: {
				log: (level) => {
					if (level === "error" || level === "warn")
						console.error("Authentication operation failed", level);
				},
			},
			advanced: { cookiePrefix: options.cookiePrefix ?? "toolstile" },
			baseURL: options.baseURL,
			secret: options.secret,
			plugins: [
				...(options.oauth ? agentOAuthPlugins(options.oauth) : []),
				...(options.cliDevices ? cliDevicePlugins(options.cliDevices) : []),
			],
			emailAndPassword: {
				enabled: true,
				minPasswordLength: 12,
				maxPasswordLength: 128,
			},
			account: {
				encryptOAuthTokens: true,
				accountLinking: {
					enabled: true,
					disableImplicitLinking: true,
					allowDifferentEmails: false,
				},
			},
			session: {
				cookieCache: { enabled: false },
				freshAge: SESSION_FRESH_AGE_SECONDS,
			},
			emailVerification: options.sendVerificationEmail
				? {
						sendOnSignUp: true,
						sendVerificationEmail: options.sendVerificationEmail,
					}
				: undefined,
			socialProviders: options.socialProviders ?? {},
			hooks: {
				before: createAuthMiddleware(async (ctx) => {
					// The router matches disabled paths exactly; this also covers templated ones
					// such as /reset-password/:token, and calls that bypass the router.
					if (ctx.path && UNUSED_AUTH_PATHS.includes(ctx.path))
						throw new APIError("NOT_FOUND");
					await issuance?.begin(ctx.context, ctx.path, ctx.body);
					if (
						ctx.path === "/sign-up/email" &&
						typeof ctx.body?.password === "string" &&
						!ctx.body.password.trim()
					)
						throw new APIError("BAD_REQUEST", {
							message:
								"Use letters, numbers or symbols. A password of only spaces is not allowed.",
						});
				}),
			},
			databaseHooks: {
				// Sign-in verifies the provider ID token before these writes; nothing reads it
				// back, and encryptOAuthTokens covers only access/refresh tokens, so never keep it.
				account: {
					create: { before: async (data) => ({ data: withoutIdToken(data) }) },
					update: { before: async (data) => ({ data: withoutIdToken(data) }) },
				},
				session: {
					create: {
						before: async (data) => {
							await options.canSignIn?.(data.userId);
							return { data };
						},
						after: async (session, context) => {
							if (
								!((await issuance?.confirm(context?.context, session)) ?? true)
							)
								throw new APIError("UNAUTHORIZED", {
									message:
										"This account was recovered or changed while signing in. Sign in again.",
								});
						},
					},
				},
				user: {
					create: {
						before: async (data) => {
							const state = await getOAuthState();
							if (
								!(await options.canRegister(data.email, {
									invitationToken:
										typeof state?.invitationToken === "string"
											? state.invitationToken
											: undefined,
									verified: data.emailVerified,
								}))
							)
								throw new Error("An invitation is required");
							return { data: { ...data, name: displayName(data.name) } };
						},
					},
					update: {
						before: async (data) =>
							"name" in data
								? { data: { ...data, name: displayName(data.name) } }
								: { data },
					},
				},
			},
		}),
	);
}
export * from "./http";
export * from "./session-check";
export type { SessionIssuanceOptions } from "./session-issuance";
