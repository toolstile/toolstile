import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { agentTools } from "@toolstile/api/agent-tools";
import {
	type ApprovalServices,
	createApprovalRouter,
} from "@toolstile/api/approval-server";
import {
	type ConnectorRequest,
	connectionCheckFailed,
	connectionLogos,
	connectorRequestError,
	createConnectorRouter,
	createConnectorService,
	registeredClientFor,
} from "@toolstile/api/connector-server";
import type {
	Actor,
	ConnectConnectorInput,
	connectionCreatedView,
	LocalCommandInput,
} from "@toolstile/api/contract";
import {
	type AccountServices,
	type AllAgentGrantServices,
	createAccountRouter,
	createAllAgentGrantRouter,
	createCommonRouter,
	createRpcHandler,
	rpcCallerError,
	type Services,
} from "@toolstile/api/server";
import {
	createToolReviewRouter,
	createToolReviewStore,
	type ToolReviewServices,
} from "@toolstile/api/tool-review-server";
import {
	createAgentConsentHandler,
	createAuth,
	createBrowserDeviceStore,
	createCliHttpHandler,
	createMcpHttpHandler,
	createOAuthClientNameResolver,
	createOAuthSelectionStore,
	createUpstreamOAuthHttpHandlers,
	digest,
	issueToken,
	liveSession,
	SESSION_FRESH_AGE_SECONDS,
	secretBox,
	smtpDelivery,
	withOAuthRequest,
} from "@toolstile/auth";
import {
	agents,
	allocateNamespaces,
	authSchema,
	connectionOAuth,
	connections,
	devices,
	openDatabase,
	purgeExpiredOAuth,
	purgeExpiredSessions,
	serverPoolOptions,
	session as sessions,
	user,
} from "@toolstile/database";
import {
	type ActivityOrigin,
	activityOrigin,
} from "@toolstile/database/activity-origin";
import {
	type ConnectionStatus,
	checkedStatus,
	checkFailureFrom,
	isSignInStatus,
	signInStatuses,
} from "@toolstile/database/connection-status";
import {
	ConnectorRequestConflict,
	cleanupConnectorRequests,
} from "@toolstile/database/connector-catalog";
import { type Transaction, transaction } from "@toolstile/database/transaction";
import {
	agentToolCatalog,
	checkConnection,
	checkLocalCommand,
	closeLocalCommands,
	connectionLabel,
	createMcpGateway,
	type DebugSql,
	detectServerAddress,
	inspect,
	type LocalCommand,
	LocalCommandError,
	observeToolCatalog,
	operationCapability,
	permitted,
	type Runtime,
	testAgentTool,
	type Upstream,
	UpstreamUnavailableError,
	validateUpstreamHeaders,
} from "@toolstile/gateway";
import { BodyReadError, readJsonBody } from "@toolstile/gateway/request-body";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	notInArray,
	or,
} from "drizzle-orm";
import { createEmailVerificationToken } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { createAccountEmail } from "./account-email";
import { createAccountService } from "./accounts";
import { createInstanceApprovals } from "./approvals";
import { catalogSource } from "./catalog";
import {
	commandLabel,
	createLocalCommandRouter,
	displayCommand,
} from "./commands";
import { createInstanceDebug } from "./debug";
import { env } from "./env";
import { accountFence, accountSessionIssuance, operatorsFence } from "./fences";
import { registerLifecycleRuntime } from "./lifecycle";
import { createInstanceDestinationPolicy } from "./network";
import { createOperatorRouter, createOperatorService } from "./operator";
import * as instanceSchema from "./schema";
import {
	activity,
	allAgentGrants,
	authorizations,
	grants,
	invitations,
	localCommands,
	type profiles,
} from "./schema";
import { createSetupRouter } from "./setup";
import {
	createSetupAccount,
	offersSetupLink,
	setupLinkUsable,
} from "./setup-link";
import { createTelemetryService } from "./telemetry";
import { createInstanceUpstreamOAuth } from "./upstream";
/** Construct runtime services inside the request owner. Module evaluation must
 * never start authentication database I/O, timers or random session state. */
export function createInstanceRuntime(
	options: { gateway?: ReturnType<typeof createMcpGateway> } = {},
) {
	const { db, pool, storage } = openDatabase(env.DATABASE_URL, {
		...serverPoolOptions(process.env, "toolstile"),
		schema: instanceSchema,
	});
	const readinessPool = /^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)
		? openDatabase(env.DATABASE_URL, {
				max: 1,
				connectionTimeoutMillis: 1000,
				statement_timeout: 1000,
			}).pool
		: pool;
	const box = secretBox(env.ENCRYPTION_KEY);
	const toolReview = createToolReviewStore({
		pool,
		tables: {
			settings: "tool_review_settings",
			definitions: "tool_definitions",
			reviews: "tool_reviews",
		},
		// A review change is an account change (fences.ts).
		fences: (actor) => [accountFence(actor.userId)],
		async authorize(executor, actor, connectionId) {
			await ownConnection(actor, connectionId, executor);
			return { canReview: true };
		},
		async visible(actor) {
			await active(actor.userId);
			return db
				.select({ id: connections.id, label: connections.label })
				.from(connections)
				.where(eq(connections.ownerId, actor.userId))
				.orderBy(connections.createdAt, connections.id);
		},
		baseline: async (actor, connectionId) =>
			observeToolCatalog(
				userRuntime(actor, "Dashboard", undefined, connectionId),
				await inspectionUpstream(actor, connectionId),
			),
		changed: (actor) => revokeUserConnections(actor.userId),
	});
	const approvals = createInstanceApprovals({
		pool,
		box,
		secret: env.ENCRYPTION_KEY,
		baseURL: env.BETTER_AUTH_URL,
		toolReviews: toolReview.forConnections,
	});
	const destinationPolicy = createInstanceDestinationPolicy(pool);
	const accountEmail = createAccountEmail(pool, box, smtpDelivery(process.env));
	const accounts = createAccountService(
		pool,
		accountEmail.enabled
			? {
					enqueueRecovery: async (tx, userId, email, code) =>
						accountEmail.enqueue(
							tx,
							userId,
							digest(code),
							{
								to: email,
								subject: "Recover your Toolstile account",
								text: `Enter this one-use code on the account recovery form: ${code}
It expires in 15 minutes. If you did not request recovery, ignore this message.`,
							},
							new Date(Date.now() + 900000),
						),
				}
			: {},
	);
	const registration = new AsyncLocalStorage<{
		email: string;
		token: string;
	}>();
	const oauthSelection = createOAuthSelectionStore(pool);
	/** Queues the verification email of a new account (sign-up and setup link) when SMTP is set. */
	const sendVerificationEmail = accountEmail.enabled
		? async ({
				user,
				url,
				token,
			}: {
				user: { id: string; email: string };
				url: string;
				token: string;
			}) => {
				if (user.email.endsWith("@users.invalid")) return;
				await transaction(pool, async (tx) => {
					await accountEmail.enqueue(
						tx,
						user.id,
						digest(token),
						{
							to: user.email,
							subject: "Verify your Toolstile email",
							text: `Verify your recovery email: ${url}`,
						},
						new Date(Date.now() + 3600000),
					);
				});
			}
		: undefined;
	const auth = createAuth({
		database: db,
		schema: authSchema,
		sessionIssuance: accountSessionIssuance(pool),
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		socialProviders: {
			...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
				? {
						github: {
							clientId: process.env.GITHUB_CLIENT_ID,
							clientSecret: process.env.GITHUB_CLIENT_SECRET,
						},
					}
				: {}),
			...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
				? {
						google: {
							clientId: process.env.GOOGLE_CLIENT_ID,
							clientSecret: process.env.GOOGLE_CLIENT_SECRET,
						},
					}
				: {}),
		},
		canRegister: async (email, identity) => {
			const local = registration.getStore();
			return operatorService.canRegister(
				email,
				local?.email === email.toLowerCase()
					? local.token
					: (identity?.invitationToken ?? ""),
				!!identity?.verified,
				!local,
			);
		},
		canSignIn: async (userId) => {
			await active(userId);
		},
		sendVerificationEmail,
		oauth: {
			resource: `${env.BETTER_AUTH_URL}/mcp`,
			selection: oauthSelection.lookup,
			validateAuthorization: async (userId, referenceId) => {
				await oauthAuthorization(userId, referenceId);
			},
		},
		cliDevices: { pool, verificationUri: "/auth/device" },
	});
	const mcpGateway = options.gateway ?? createMcpGateway();
	async function revokeMcp(key: string) {
		await mcpGateway.revoke(key);
	}
	const upstreamOAuth = createInstanceUpstreamOAuth({
		pool,
		box,
		baseURL: env.BETTER_AUTH_URL,
		registeredClient: async (origin) => registeredClientFor(origin),
		authorize: (userId, id) => ownConnection({ userId, scopeId: userId }, id),
		validateDestination: destinationPolicy.validateDestination,
		fetch: destinationPolicy.fetch,
	});
	const denied = () =>
		new ORPCError("FORBIDDEN", { message: "Unavailable or access denied" });
	async function active(userId: string, executor: DebugSql = pool) {
		const {
			rows: [profile],
		} = await executor.query<typeof profiles.$inferSelect>(
			'select * from profiles where "userId"=$1',
			[userId],
		);
		if (profile?.suspended || profile?.deletedAt) throw denied();
		return profile;
	}
	async function ownConnection(
		actor: Actor,
		id: string,
		executor: DebugSql = pool,
	) {
		await active(actor.userId, executor);
		const {
			rows: [row],
		} = await executor.query<typeof connections.$inferSelect>(
			'select * from connections where id=$1 and "ownerId"=$2',
			[id, actor.userId],
		);
		if (!row) throw denied();
		return row;
	}
	async function ownAgent(actor: Actor, id: string, executor: DebugSql = pool) {
		await active(actor.userId, executor);
		const {
			rows: [row],
		} = await executor.query<typeof agents.$inferSelect>(
			'select * from agents where id=$1 and "ownerId"=$2',
			[id, actor.userId],
		);
		if (!row) throw denied();
		return row;
	}
	function safeHeaders(headers: Record<string, string>) {
		try {
			return validateUpstreamHeaders(headers, {
				message: "Unsupported upstream header",
			});
		} catch {
			throw new ORPCError("BAD_REQUEST", {
				message: "Unsupported upstream header",
			});
		}
	}
	async function toolTestContext(
		actor: Actor,
		input: {
			agentId: string;
			connectionId: string;
		},
	) {
		const agent = await ownAgent(actor, input.agentId);
		const current = userRuntime(
			actor,
			`Dashboard test / ${agent.label}`,
			input.agentId,
		);
		const upstream = (await current.connections()).find(
			(connection) => connection.id === input.connectionId,
		);
		if (!upstream) throw denied();
		return { current, upstream };
	}
	async function fresh(actor: Actor) {
		await active(actor.userId);
		if (!actor.sessionId) throw denied();
		const [current] = await db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.id, actor.sessionId),
					eq(sessions.userId, actor.userId),
					gt(sessions.expiresAt, new Date()),
				),
			);
		if (
			!current ||
			current.createdAt <
				new Date(Date.now() - SESSION_FRESH_AGE_SECONDS * 1000)
		)
			throw new ORPCError("FORBIDDEN", {
				message: "Sign in again before changing account security",
			});
	}
	/** Runs a Drizzle statement on the caller's transaction. */
	const run = (
		tx: Transaction,
		query: { toSQL(): { sql: string; params: unknown[] } },
	) => {
		const { sql, params } = query.toSQL();
		return tx.query(sql, params);
	};
	async function deleteAgents(tx: Transaction, ids: string[]) {
		if (!ids.length) return;
		const agentIds = JSON.stringify(ids);
		const referenceIds =
			'SELECT id FROM authorizations WHERE "agentId" IN (SELECT value FROM jsonb_array_elements_text(?))';
		await tx.query(
			`DELETE FROM "oauthAccessToken" WHERE "referenceId" IN (${referenceIds}) OR "refreshId" IN (SELECT id FROM "oauthRefreshToken" WHERE "referenceId" IN (${referenceIds}))`,
			[agentIds, agentIds],
		);
		for (const table of [
			"oauthRefreshToken",
			"oauthConsent",
			"oauth_flow_selection",
		])
			await tx.query(
				`DELETE FROM "${table}" WHERE "referenceId" IN (${referenceIds})`,
				[agentIds],
			);
		for (const table of ["grants", "authorizations"])
			await tx.query(
				`DELETE FROM ${table} WHERE "agentId" IN (SELECT value FROM jsonb_array_elements_text(?))`,
				[agentIds],
			);
		await tx.query(
			"DELETE FROM agents WHERE id IN (SELECT value FROM jsonb_array_elements_text(?))",
			[agentIds],
		);
	}
	/** An owner-scoped change: serializable, holding the account fence (fences.ts). */
	const accountTransaction = <T>(
		actor: Actor,
		work: (tx: Transaction) => Promise<T>,
	) => transaction(pool, work, { fences: [accountFence(actor.userId)] });
	/** The account is live and, for a person's request, its session row (share-locked, so a
	 * sign-out or revocation committed first is always seen) still exists. */
	async function checkAccount(tx: Transaction, actor: Actor) {
		const result = await tx.query(
			`SELECT u.id FROM "user" u LEFT JOIN profiles p ON p."userId"=u.id
      WHERE u.id=? AND COALESCE(p.suspended,false)=false AND p."deletedAt" IS NULL`,
			[actor.userId],
		);
		if (!result.rows.length) throw denied();
		if (actor.sessionId && !(await liveSession(tx, actor))) throw denied();
	}
	async function revokeUserConnections(userId: string) {
		const rows = await db
			.select({ id: agents.id })
			.from(agents)
			.where(eq(agents.ownerId, userId));
		await Promise.all(rows.map((row) => revokeMcp(`${userId}:${row.id}`)));
	}
	const debug = createInstanceDebug({
		pool,
		box,
		active,
		ownAgent,
		ownConnection,
	});
	/** What a stored local command runs; the environment is decrypted only here, on the server. */
	function localCommand(
		row: typeof localCommands.$inferSelect | null | undefined,
	): LocalCommand | undefined {
		return row
			? {
					command: row.command,
					args: row.args,
					env: box.decrypt(row.encryptedEnv),
				}
			: undefined;
	}
	/** Local commands need the server's switch and, every time, an operator as their owner: a
	 * child process runs as the server's user and could read the instance keys. */
	async function commandOwner(actor: Actor, executor: DebugSql = pool) {
		if (!env.localCommands)
			throw new ORPCError("FORBIDDEN", {
				message:
					"Local commands are turned off on this server. Start it in local mode with TOOLSTILE_STDIO=on to use them.",
			});
		const profile = await active(actor.userId, executor);
		if (!profile?.operator)
			throw new ORPCError("FORBIDDEN", {
				message: "Only instance operators can add and run local commands",
			});
	}
	/** Saves a local command after it started and answered the MCP handshake. */
	async function addLocalCommand(
		actor: Actor,
		input: LocalCommandInput,
		signal?: AbortSignal,
	) {
		// Checked before the command is started, so nobody else can run one through the check.
		await commandOwner(actor);
		const command = {
			command: input.command,
			args: input.args,
			env: input.env,
		};
		try {
			// Checked again once a slot is free, right before the command starts.
			await checkLocalCommand(command, {
				authorize: () => commandOwner(actor),
				signal,
			});
		} catch (error) {
			if (error instanceof ORPCError) throw error;
			throw new ORPCError("BAD_GATEWAY", {
				message:
					error instanceof LocalCommandError
						? `Toolstile couldn't start this command: ${error.reason}`
						: "Toolstile couldn't start this command.",
			});
		}
		const id = randomUUID(),
			label = input.label ?? commandLabel(input.command, input.args),
			status = checkedStatus("headers");
		await transaction(
			pool,
			async (tx) => {
				await checkAccount(tx, actor);
				await commandOwner(actor, tx);
				await run(
					tx,
					db.insert(connections).values({
						id,
						ownerId: actor.userId,
						label,
						url: "",
						transport: "stdio",
						authentication: "headers",
						encryptedHeaders: box.encrypt({}),
						status,
					}),
				);
				await run(
					tx,
					db.insert(localCommands).values({
						connectionId: id,
						command: input.command,
						args: input.args,
						encryptedEnv: box.encrypt(input.env),
					}),
				);
			},
			// A concurrent change of operators is serialized with this one.
			{ fences: [operatorsFence, accountFence(actor.userId)] },
		);
		return { id, label, status };
	}
	async function createConnection(
		actor: Actor,
		input: Parameters<Services["addConnection"]>[1],
	) {
		await active(actor.userId);
		await destinationPolicy.validateDestination(new URL(input.url));
		const headers = safeHeaders(input.headers);
		// An address without a path may be saved at /mcp or /sse instead; see detectServerAddress.
		const { url, ...detected } = await detectServerAddress({
			...input,
			headers,
			fetch: destinationPolicy.fetch,
		});
		const label = input.label ?? connectionLabel(url);
		const id = randomUUID();
		await accountTransaction(actor, async (tx) => {
			await checkAccount(tx, actor);
			await run(
				tx,
				db.insert(connections).values({
					id,
					ownerId: actor.userId,
					label,
					url,
					...detected,
					encryptedHeaders: box.encrypt(headers),
				}),
			);
		});
		return { id, label, url, ...detected };
	}
	/** Stores exactly the confirmed URL after a real check of that URL; see ConnectConnectorInput. */
	async function createConfirmedConnection(
		actor: Actor,
		input: ConnectConnectorInput,
		request: ConnectorRequest,
	) {
		const headers = safeHeaders(input.headers);
		type Response = z.infer<typeof connectionCreatedView>;
		/** Under the account lock, which serializes this owner's requests: a matching earlier
		 * response that is still valid, or undefined for a new request. */
		async function prepared(tx: Transaction) {
			await checkAccount(tx, actor);
			const {
				rows: [record],
			} = await tx.query(
				`SELECT fingerprint,response FROM connector_requests
          WHERE owner_id=? AND scope_id=? AND request_id=? AND created_at>=clock_timestamp() - (86400000) * interval '1 millisecond'`,
				[actor.userId, actor.scopeId, request.requestId],
			);
			if (!record) return undefined;
			if (record.fingerprint !== request.fingerprint)
				throw new ConnectorRequestConflict(
					"This connection request was already used with different settings. Start a new connection.",
				);
			const response = record.response as Response;
			const current = await tx.query(
				'SELECT id FROM connections WHERE id=? AND "ownerId"=?',
				[response.id, actor.userId],
			);
			if (!current.rows.length)
				throw new ConnectorRequestConflict(
					"This connection was removed. Start a new connection.",
				);
			return response;
		}
		try {
			const first = await accountTransaction(actor, prepared);
			if (first) return first;
			let failure: unknown;
			const checked = await destinationPolicy
				.validateDestination(new URL(input.url))
				.then(() =>
					checkConnection({
						url: input.url,
						headers,
						transport: input.transport ?? "auto",
						authentication: input.authentication,
						fetch: destinationPolicy.fetch,
					}),
				)
				.catch((error: unknown) => {
					failure = error;
					return undefined;
				});
			return await accountTransaction(actor, async (tx) => {
				// A concurrent request with the same ID that succeeded meanwhile still replays.
				const response = await prepared(tx);
				if (response) return response;
				if (!checked) throw failure;
				if (!checked.ok) throw connectionCheckFailed();
				const id = randomUUID(),
					label = input.label ?? connectionLabel(input.url);
				const saved = {
					transport: checked.transport,
					authentication: input.authentication,
					status: checked.status,
				};
				const result = { id, label, url: input.url, ...saved };
				await tx.query(
					`DELETE FROM connector_requests WHERE owner_id=? AND scope_id=? AND request_id=? AND created_at<clock_timestamp() - (86400000) * interval '1 millisecond'`,
					[actor.userId, actor.scopeId, request.requestId],
				);
				await run(
					tx,
					db.insert(connections).values({
						id,
						ownerId: actor.userId,
						label,
						url: input.url,
						...saved,
						encryptedHeaders: box.encrypt(headers),
						connectorId: request.suggestionId,
					}),
				);
				await tx.query(
					"INSERT INTO connector_requests(owner_id,scope_id,request_id,fingerprint,response) VALUES(?,?,?,?,?)",
					[
						actor.userId,
						actor.scopeId,
						request.requestId,
						request.fingerprint,
						JSON.stringify(result),
					],
				);
				return result;
			});
		} catch (error) {
			throw connectorRequestError(error);
		}
	}

	const connectorService = createConnectorService({
		source: { read: () => catalogSource().read() },
		key: env.ENCRYPTION_KEY,
		authorize: (actor) => active(actor.userId),
		async preview(_actor, url) {
			await destinationPolicy.validateDestination(new URL(url));
			const { url: resolved, ...detected } = await detectServerAddress({
				url,
				fetch: destinationPolicy.fetch,
			});
			return { url: resolved, ...detected };
		},
		create: createConfirmedConnection,
	});
	/** The Activity rows a user sees: their own within the instance's retention. */
	async function visibleActivity(actor: Actor) {
		const {
			rows: [retention],
		} = await pool.query(
			'select "activityRetentionDays" from instance_settings where id=$1',
			["instance"],
		);
		return and(
			eq(activity.ownerId, actor.userId),
			gt(
				activity.createdAt,
				new Date(
					Date.now() - (retention?.activityRetentionDays ?? 30) * 86400000,
				),
			),
		);
	}
	function activityItem(e: typeof activity.$inferSelect) {
		return {
			id: e.id,
			agent: e.agent,
			connection: e.connection,
			origin: activityOrigin(e.origin, e.agent),
			method: e.method,
			target: e.target,
			outcome: e.outcome,
			durationMs: e.durationMs,
			createdAt: e.createdAt.toISOString(),
		};
	}
	const services = {
		...approvals.services,
		...toolReview.services,
		debugStatus: debug.status,
		startDebug: debug.start,
		extendDebug: debug.extend,
		stopDebug: debug.stop,
		debugPayload: debug.payload,
		async accountStatus(actor) {
			await active(actor.userId);
			const {
				rows: [person],
			} = await pool.query('select email from "user" where id=$1', [
				actor.userId,
			]);
			const { rows: providers } = await pool.query(
				'select "providerId" from account where "userId"=$1',
				[actor.userId],
			);
			const {
				rows: [codes],
			} = await pool.query(
				`select count(*) as count from recovery_codes where "userId"=$1 and purpose='recovery'`,
				[actor.userId],
			);
			const {
				rows: [settings],
			} = await pool.query(
				'select "recoveryWindowDays" from instance_settings where id=$1',
				["instance"],
			);
			return {
				identifier: person.email,
				providers: providers.map((row) => row.providerId),
				recoveryCodesRemaining: codes.count,
				recoveryWindowDays: settings?.recoveryWindowDays ?? 7,
			};
		},
		async rotateRecoveryCodes(actor) {
			await fresh(actor);
			return {
				codes: await accounts.rotateCodes(actor.userId, actor.sessionId),
			};
		},
		async deleteAccount(actor) {
			await fresh(actor);
			// The last-operator check spans every operator profile: the operators fence, then the
			// account's own.
			const result = await transaction(
				pool,
				async (tx) => {
					const {
						rows: [profile],
					} = await tx.query(
						'select operator from profiles where "userId"=$1',
						[actor.userId],
					);
					if (profile?.operator) {
						const {
							rows: [count],
						} = await tx.query(
							'select count(*) as n from profiles where operator=true and suspended=false and "deletedAt" is null',
						);
						if (count.n <= 1)
							throw new ORPCError("FORBIDDEN", {
								message: "The last active operator cannot be deleted",
							});
					}
					return accounts.deleteAccount(
						actor.userId,
						actor.userId,
						actor.sessionId,
						tx,
					);
				},
				{ fences: [operatorsFence, accountFence(actor.userId)] },
			);
			await revokeUserConnections(actor.userId);
			return result;
		},
		async saveAllAgentGrant(actor, input) {
			// Rules are approval-binding state: change them under the account lock.
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				await ownConnection(actor, input.connectionId, tx);
				await run(
					tx,
					db
						.insert(allAgentGrants)
						.values({ id: randomUUID(), ownerId: actor.userId, ...input })
						.onConflictDoUpdate({
							target: [allAgentGrants.ownerId, allAgentGrants.connectionId],
							set: { rules: input.rules },
						}),
				);
			});
			await revokeUserConnections(actor.userId);
		},
		async removeAllAgentGrant(actor, connectionId) {
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				await ownConnection(actor, connectionId, tx);
				await run(
					tx,
					db
						.delete(allAgentGrants)
						.where(
							and(
								eq(allAgentGrants.ownerId, actor.userId),
								eq(allAgentGrants.connectionId, connectionId),
							),
						),
				);
			});
			await revokeUserConnections(actor.userId);
		},
		async agentCatalog(actor, input) {
			const { current, upstream } = await toolTestContext(actor, input);
			return { tools: await agentToolCatalog(current, upstream) };
		},
		async testTool(actor, input) {
			const { current, upstream } = await toolTestContext(actor, input);
			return testAgentTool(current, upstream, input.name, input.arguments);
		},
		async startConnectionOAuth(actor, input) {
			if (!actor.sessionId) throw new ORPCError("UNAUTHORIZED");
			const connection = await ownConnection(actor, input.id);
			if (connection.transport === "stdio")
				throw new ORPCError("BAD_REQUEST", {
					message: "Local commands don't use browser sign-in",
				});
			return upstreamOAuth.begin(
				{ userId: actor.userId, sessionId: actor.sessionId },
				input.id,
				undefined,
				input,
			);
		},
		async snapshot(actor) {
			const profile = await active(actor.userId);
			const [person] = await db
				.select()
				.from(user)
				.where(eq(user.id, actor.userId));
			const ownDevices = await db
				.select()
				.from(devices)
				.where(
					and(eq(devices.ownerId, actor.userId), isNull(devices.revokedAt)),
				)
				.orderBy(devices.createdAt, devices.id);
			const ownAgents = await db
				.select({
					id: agents.id,
					label: agents.label,
					deviceId: agents.deviceId,
					expiresAt: authorizations.expiresAt,
				})
				.from(agents)
				.innerJoin(authorizations, eq(agents.id, authorizations.agentId))
				.where(
					and(
						eq(agents.ownerId, actor.userId),
						isNull(authorizations.revokedAt),
					),
				)
				.orderBy(agents.createdAt, agents.id);
			const ownConnections = await db
				.select({
					id: connections.id,
					label: connections.label,
					url: connections.url,
					transport: connections.transport,
					status: connections.status,
					authentication: connections.authentication,
					connectorId: connections.connectorId,
					local: localCommands,
				})
				.from(connections)
				.leftJoin(localCommands, eq(localCommands.connectionId, connections.id))
				.where(eq(connections.ownerId, actor.userId))
				// Status updates and renames rewrite rows, which reorders an unsorted scan.
				.orderBy(connections.createdAt, connections.id);
			const ownGrants = await db
				.select({
					agentId: grants.agentId,
					connectionId: grants.connectionId,
					rules: grants.rules,
				})
				.from(grants)
				.innerJoin(agents, eq(grants.agentId, agents.id))
				.where(eq(agents.ownerId, actor.userId));
			const events = await db
				.select()
				.from(activity)
				.where(await visibleActivity(actor))
				.orderBy(desc(activity.createdAt))
				.limit(100);
			return {
				user: {
					name: person.name,
					email: person.email,
					operator: !!profile?.operator,
				},
				devices: ownDevices.map((d) => ({
					id: d.id,
					label: d.label,
					revoked: false,
				})),
				agents: ownAgents
					.filter((a) => ownDevices.some((d) => d.id === a.deviceId))
					.map((a) => ({
						id: a.id,
						canTest: true,
						label: a.label,
						deviceId: a.deviceId,
						revoked: false,
						expiresAt: a.expiresAt?.toISOString() ?? null,
					})),
				connections: (
					await connectionLogos(catalogSource(), ownConnections)
				).map(({ local, ...c }) => ({
					...c,
					// Names only: environment values never leave the server.
					...(local
						? {
								command: displayCommand(local.command, local.args),
								environment: Object.keys(
									box.decrypt(local.encryptedEnv),
								).sort(),
							}
						: {}),
					authentication: c.authentication as "headers" | "oauth",
					canManageAuthentication: c.transport !== "stdio",
				})),
				grants: ownGrants,
				allAgentGrants: await db
					.select({
						connectionId: allAgentGrants.connectionId,
						rules: allAgentGrants.rules,
					})
					.from(allAgentGrants)
					.where(eq(allAgentGrants.ownerId, actor.userId)),
				activity: events.map(activityItem),
				localCommands: env.localCommands && !!profile?.operator,
			};
		},
		async activityRequest(actor, id) {
			await active(actor.userId);
			const [event] = await db
				.select()
				.from(activity)
				.where(and(eq(activity.id, id), await visibleActivity(actor)))
				.limit(1);
			return event ? activityItem(event) : null;
		},
		addConnection: (actor, input) => createConnection(actor, input),
		async removeConnection(actor, id) {
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				if (
					!(
						await tx.query(
							'SELECT id FROM connections WHERE id=? AND "ownerId"=?',
							[id, actor.userId],
						)
					).rows.length
				)
					throw denied();
				await tx.query(
					`UPDATE tool_approvals SET status='invalidated',"encryptedRequest"=NULL,"settledAt"=clock_timestamp() WHERE "scopeId"=? AND "connectionId"=? AND status IN ('pending','approved','claimed')`,
					[actor.userId, id],
				);
				await run(tx, db.delete(connections).where(eq(connections.id, id)));
			});
			await upstreamOAuth.cleanupUnusedGrants();
		},
		async addDevice(actor, label) {
			const id = randomUUID();
			// Every person-initiated change: the account fence and a live-session check.
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				await run(
					tx,
					db.insert(devices).values({ id, label, ownerId: actor.userId }),
				);
			});
			return { id };
		},
		async addAgent(actor, input) {
			const id = randomUUID(),
				token = issueToken();
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				const {
					rows: [device],
				} = await tx.query(
					'SELECT id FROM devices WHERE id=? AND "ownerId"=? AND "revokedAt" IS NULL',
					[input.deviceId, actor.userId],
				);
				if (!device || typeof device.id !== "string") throw denied();
				await run(
					tx,
					db.insert(agents).values({
						id,
						ownerId: actor.userId,
						deviceId: device.id,
						label: input.label,
					}),
				);
				await run(
					tx,
					db.insert(authorizations).values({
						id: randomUUID(),
						agentId: id,
						tokenHash: digest(token),
						expiresAt:
							input.expiresInDays === null
								? null
								: new Date(Date.now() + input.expiresInDays * 86400000),
					}),
				);
			});
			return { id, token };
		},
		async renameDevice(actor, input) {
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				const updated = await run(
					tx,
					db
						.update(devices)
						.set({ label: input.label })
						.where(
							and(
								eq(devices.id, input.id),
								eq(devices.ownerId, actor.userId),
								isNull(devices.revokedAt),
							),
						)
						.returning({ id: devices.id }),
				);
				if (!updated.rows.length) throw denied();
			});
		},
		async renameAgent(actor, input) {
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				await ownAgent(actor, input.id, tx);
				await run(
					tx,
					db
						.update(agents)
						.set({ label: input.label })
						.where(eq(agents.id, input.id)),
				);
			});
		},
		async revokeAgent(actor, id) {
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				if (
					!(
						await tx.query('SELECT id FROM agents WHERE id=? AND "ownerId"=?', [
							id,
							actor.userId,
						])
					).rows.length
				)
					throw denied();
				await deleteAgents(tx, [id]);
			});
			await revokeMcp(`${actor.userId}:${id}`);
		},
		async revokeDevice(actor, id) {
			const affected = await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				if (
					!(
						await tx.query(
							'SELECT id FROM devices WHERE id=? AND "ownerId"=?',
							[id, actor.userId],
						)
					).rows.length
				)
					throw denied();
				const { rows } = await tx.query(
					'SELECT id FROM agents WHERE "deviceId"=? ORDER BY id',
					[id],
				);
				await deleteAgents(
					tx,
					rows.map((row) => String(row.id)),
				);
				await run(tx, db.delete(devices).where(eq(devices.id, id)));
				return rows;
			});
			await Promise.all(
				affected.map((agent) => revokeMcp(`${actor.userId}:${agent.id}`)),
			);
		},
		async saveGrant(actor, input) {
			await accountTransaction(actor, async (tx) => {
				await checkAccount(tx, actor);
				await ownConnection(actor, input.connectionId, tx);
				await ownAgent(actor, input.agentId, tx);
				await run(
					tx,
					db
						.insert(grants)
						.values({ id: randomUUID(), ...input })
						.onConflictDoUpdate({
							target: [grants.agentId, grants.connectionId],
							set: { rules: input.rules },
						}),
				);
			});
			await revokeMcp(`${actor.userId}:${input.agentId}`);
		},
		async verify(actor, id) {
			const connection = await inspectionUpstream(actor, id);
			const runtime = userRuntime(actor, "Dashboard", undefined, id);
			try {
				const { inventory: _, ...result } = await inspect(runtime, connection);
				// Sign-in states change only through sign-in; see connection-status.ts.
				await db
					.update(connections)
					.set({ status: checkedStatus(connection.authentication) })
					.where(
						and(
							eq(connections.id, id),
							notInArray(connections.status, [...signInStatuses]),
						),
					);
				return result;
			} catch (error) {
				// A server that did not answer may be briefly down; keep its stored status.
				if (
					error instanceof UpstreamUnavailableError ||
					error instanceof ORPCError
				)
					throw error;
				await db
					.update(connections)
					.set({ status: "needs attention" })
					.where(
						and(
							eq(connections.id, id),
							inArray(connections.status, [...checkFailureFrom]),
						),
					);
				throw new ORPCError("BAD_GATEWAY", {
					message: isSignInStatus(connection.status)
						? "Sign in to this server, then check its tools again."
						: "Couldn't load this server's tools. Check its address and sign-in, then try again.",
				});
			}
		},
	} satisfies Services &
		AccountServices &
		AllAgentGrantServices &
		ApprovalServices &
		ToolReviewServices;
	async function inspectionUpstream(
		actor: Actor,
		id: string,
	): Promise<
		Upstream & {
			connectorId: string | null;
			authentication: string;
			status: ConnectionStatus;
		}
	> {
		const connection = await ownConnection(actor, id);
		const [oauth] = await db
			.select()
			.from(connectionOAuth)
			.where(eq(connectionOAuth.connectionId, id));
		const review = await toolReview.forConnections(pool, actor.userId, [id]);
		const namespaces = await allocateNamespaces(pool, actor.userId, [
			connection,
		]);
		const [local] = await db
			.select()
			.from(localCommands)
			.where(eq(localCommands.connectionId, id));
		return {
			...connection,
			command: localCommand(local),
			namespace: namespaces.get(id),
			toolReview: review.get(id),
			identityKey: oauth?.grantId ?? connection.encryptedHeaders,
			headers: box.decrypt(connection.encryptedHeaders),
			authProvider:
				connection.authentication === "oauth"
					? upstreamOAuth.runtimeProvider(connection.id, connection.url)
					: undefined,
			rules: [],
		};
	}
	/** `origin` is `agent` only for requests an agent sent to the MCP endpoint. */
	function userRuntime(
		actor: Actor,
		agent: string,
		agentId?: string,
		inspectionConnectionId?: string,
		origin: ActivityOrigin = "dashboard",
	): Runtime {
		return {
			approvals: agentId
				? approvals.forAgent(actor, agentId, agent)
				: undefined,
			capture: agentId
				? debug.hook(actor, agentId, (executor, operation) =>
						debug.checkAgent(actor, agentId, executor, operation),
					)
				: undefined,
			sessionKey: agentId ? `${actor.userId}:${agentId}` : undefined,
			async authenticate() {
				await active(actor.userId);
				if (!agentId) return;
				const [row] = await db
					.select()
					.from(authorizations)
					.where(eq(authorizations.agentId, agentId));
				if (!row) throw denied();
				await oauthAuthorization(actor.userId, row.id);
			},
			async check(connectionId, kind, target) {
				await userRuntime(
					actor,
					agent,
					agentId,
					inspectionConnectionId,
					origin,
				).admit({
					id: randomUUID(),
					connectionId,
					method: `${kind ?? "discovery"}/check`,
					capability: kind,
					target,
					maintenance: true,
				});
			},
			async connections() {
				if (!agentId)
					return inspectionConnectionId
						? [await inspectionUpstream(actor, inspectionConnectionId)]
						: [];
				const found = await db
					.select({
						connection: connections,
						rules: grants.rules,
						allRules: allAgentGrants.rules,
						oauthGrantId: connectionOAuth.grantId,
						local: localCommands,
					})
					.from(connections)
					.leftJoin(
						grants,
						and(
							eq(grants.connectionId, connections.id),
							eq(grants.agentId, agentId),
						),
					)
					.leftJoin(
						allAgentGrants,
						and(
							eq(allAgentGrants.connectionId, connections.id),
							eq(allAgentGrants.ownerId, actor.userId),
						),
					)
					.leftJoin(
						connectionOAuth,
						eq(connectionOAuth.connectionId, connections.id),
					)
					.leftJoin(
						localCommands,
						eq(localCommands.connectionId, connections.id),
					)
					.where(
						and(
							eq(connections.ownerId, actor.userId),
							or(
								eq(grants.agentId, agentId),
								eq(allAgentGrants.ownerId, actor.userId),
							),
						),
					);
				// Without the switch or an operator owner, local commands are left out rather
				// than failing every list; opening one is refused again in validateCommand.
				const runsCommands =
					env.localCommands && !!(await active(actor.userId))?.operator;
				const rows = found.filter(
					(row) => runsCommands || row.connection.transport !== "stdio",
				);
				const reviews = await toolReview.forConnections(
					pool,
					actor.userId,
					rows.map((row) => row.connection.id),
				);
				// Oldest first, so the first of several same-named connections keeps the plain name.
				const namespaces = await allocateNamespaces(
					pool,
					actor.userId,
					rows
						.map((row) => row.connection)
						.sort(
							(a, b) =>
								a.createdAt.getTime() - b.createdAt.getTime() ||
								a.id.localeCompare(b.id),
						),
				);
				return rows.map((row) => ({
					...row.connection,
					command: localCommand(row.local),
					namespace: namespaces.get(row.connection.id),
					toolReview: reviews.get(row.connection.id),
					identityKey: row.oauthGrantId ?? row.connection.encryptedHeaders,
					headers: box.decrypt(row.connection.encryptedHeaders),
					authProvider:
						row.connection.authentication === "oauth"
							? upstreamOAuth.runtimeProvider(
									row.connection.id,
									row.connection.url,
								)
							: undefined,
					rules: [row.rules, row.allRules].filter(
						(rule): rule is NonNullable<typeof rule> => !!rule,
					),
				}));
			},
			async admit(operation) {
				await active(actor.userId);
				if (agentId) {
					const [row] = await db
						.select({
							revokedAt: authorizations.revokedAt,
							expiresAt: authorizations.expiresAt,
							deviceRevokedAt: devices.revokedAt,
						})
						.from(authorizations)
						.innerJoin(agents, eq(authorizations.agentId, agents.id))
						.innerJoin(devices, eq(agents.deviceId, devices.id))
						.where(
							and(eq(agents.id, agentId), eq(agents.ownerId, actor.userId)),
						);
					if (
						!row ||
						row.revokedAt ||
						row.deviceRevokedAt ||
						(row.expiresAt && row.expiresAt <= new Date())
					)
						throw denied();
					const [granted] = await db
						.select({ specific: grants.rules, all: allAgentGrants.rules })
						.from(connections)
						.leftJoin(
							grants,
							and(
								eq(grants.connectionId, connections.id),
								eq(grants.agentId, agentId),
							),
						)
						.leftJoin(
							allAgentGrants,
							and(
								eq(allAgentGrants.connectionId, connections.id),
								eq(allAgentGrants.ownerId, actor.userId),
							),
						)
						.where(
							and(
								eq(connections.id, operation.connectionId),
								eq(connections.ownerId, actor.userId),
							),
						);
					const effective = [granted?.specific, granted?.all].filter(
						(rule): rule is NonNullable<typeof rule> => !!rule,
					);
					const kind = operationCapability(operation);
					if (
						!effective.length ||
						!kind ||
						(operation.target
							? !permitted(effective, kind, operation.target)
							: !effective.some(
									(rule) =>
										rule.full ||
										rule.allow[kind].length ||
										(kind === "tools" && rule.requireApproval?.length),
								))
					)
						throw denied();
				}
				if (operation.approval) {
					if (!agentId) throw denied();
					await approvals.consume(
						{
							scopeId: actor.scopeId,
							requesterId: actor.userId,
							agentId,
							agentLabel: agent,
						},
						operation.approval.id,
						operation.approval.operationId,
					);
				}
			},
			async record(operation, outcome, durationMs) {
				if (operation.maintenance) return;
				const [connection] = await db
					.select({ label: connections.label })
					.from(connections)
					.where(eq(connections.id, operation.connectionId));
				await db
					.insert(activity)
					.values({
						id: operation.id,
						ownerId: actor.userId,
						agent,
						connection: connection?.label ?? "Removed connection",
						agentId: agentId ?? null,
						connectionId: operation.connectionId,
						origin,
						method: operation.method,
						target: operation.target,
						outcome,
						durationMs,
					})
					.onConflictDoUpdate({
						target: activity.id,
						set: { outcome, durationMs },
					});
			},
			validateDestination: destinationPolicy.validateDestination,
			async validateCommand() {
				await commandOwner(actor);
			},
			fetch: destinationPolicy.fetch,
			refusalHint: (reason) =>
				new URL(
					reason === "unreviewed" ? "/app/connections" : "/app/access",
					env.BETTER_AUTH_URL,
				).toString(),
			tools: agentId
				? agentTools({
						catalog: () => connectorService.catalog(actor),
						connections: () => userRuntime(actor, agent, agentId).connections(),
					})
				: undefined,
		};
	}
	async function handleAuth(request: Request): Promise<Response> {
		return withOAuthRequest(request, (bounded) => dispatchAuth(bounded));
	}
	function jsonAuthRequest(request: Request, body: unknown) {
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		// Server route requests may be proxied; construct from the URL rather than copying the object.
		return new Request(request.url, {
			method: request.method,
			headers,
			body: JSON.stringify(body),
			signal: request.signal,
		});
	}
	/** An oversized or stalled recovery body ends with 413/408 before the
	 * confidential response applies; malformed JSON is left to validation. */
	async function recoveryBody(request: Request): Promise<unknown> {
		try {
			return await readJsonBody(request, 16 * 1024, 5_000);
		} catch (error) {
			if (error instanceof BodyReadError && error.status !== 400)
				return Response.json(
					{ message: error.message },
					{ status: error.status, headers: { "Cache-Control": "no-store" } },
				);
			return undefined;
		}
	}
	/** A sign-in or sign-up body this handler rewrites before Better Auth reads it.
	 * Malformed JSON stays an empty object for Better Auth to reject; an oversized or
	 * stalled body ends the request. */
	async function authJsonBody(
		request: Request,
	): Promise<Record<string, unknown> | Response> {
		try {
			return z
				.record(z.string(), z.unknown())
				.parse(await readJsonBody(request, 1024 * 1024));
		} catch (error) {
			if (error instanceof BodyReadError && error.status !== 400)
				return Response.json(
					{ message: error.message },
					{ status: error.status },
				);
			return {};
		}
	}
	function invitationCookie(request: Request) {
		return request.headers
			.get("cookie")
			?.split(";")
			.map((value) => value.trim())
			.find((value) => value.startsWith("toolstile_invitation="))
			?.slice("toolstile_invitation=".length);
	}
	async function dispatchAuth(request: Request) {
		const path = new URL(request.url).pathname;
		if (
			path.startsWith("/api/auth/accept-invitation/") &&
			request.method === "GET"
		) {
			const token = path.slice("/api/auth/accept-invitation/".length);
			const [invite] = await db
				.select({ id: invitations.id })
				.from(invitations)
				.where(
					and(
						eq(invitations.id, digest(token)),
						gt(invitations.expiresAt, new Date()),
					),
				);
			if (!invite)
				return new Response("Invitation unavailable or expired", {
					status: 400,
					headers: {
						"Cache-Control": "no-store",
						"Referrer-Policy": "no-referrer",
					},
				});
			return new Response(null, {
				status: 303,
				headers: {
					Location: "/auth/sign-up",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					"Set-Cookie": `toolstile_invitation=${token}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=86400${env.BETTER_AUTH_URL.startsWith("https:") ? "; Secure" : ""}`,
				},
			});
		}
		if (
			path === "/api/auth/sign-in/social" &&
			request.method === "POST" &&
			invitationCookie(request)
		) {
			const body = await authJsonBody(request);
			if (body instanceof Response) return body;
			const additionalData =
				z.record(z.string(), z.unknown()).safeParse(body.additionalData).data ??
				{};
			request = jsonAuthRequest(request, {
				...body,
				additionalData: {
					...additionalData,
					invitationToken:
						additionalData.invitationToken ?? invitationCookie(request),
				},
			});
		}
		if (
			new URL(request.url).pathname.endsWith("/request-account-recovery") &&
			request.method === "POST"
		) {
			if (request.headers.get("origin") !== env.BETTER_AUTH_URL)
				return new Response("Invalid origin", { status: 403 });
			const input = await recoveryBody(request);
			if (input instanceof Response) return input;
			try {
				const { identifier } = z
					.object({ identifier: z.string().min(1).max(320) })
					.parse(input);
				await accounts.requestEmailRecovery(identifier);
			} catch {
				/* Keep account existence and delivery availability confidential. */
			}
			return Response.json(
				{ ok: true },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (
			new URL(request.url).pathname.endsWith("/recover-account") &&
			request.method === "POST"
		) {
			if (request.headers.get("origin") !== env.BETTER_AUTH_URL)
				return new Response("Invalid origin", { status: 403 });
			const input = await recoveryBody(request);
			if (input instanceof Response) return input;
			try {
				const body = z
					.object({
						identifier: z.string().min(1).max(320),
						code: z.string().min(1).max(200),
						password: z.string().min(12).max(128),
					})
					.parse(input);
				await accounts.recover(body.identifier, body.code, body.password);
				return Response.json(
					{ ok: true },
					{ headers: { "Cache-Control": "no-store" } },
				);
			} catch {
				return Response.json(
					{ message: "Account recovery is unavailable or the code is invalid" },
					{ status: 400 },
				);
			}
		}
		if (path === "/api/auth/account-options" && request.method === "GET") {
			const token = invitationCookie(request);
			const [invite] = token
				? await db
						.select({ email: invitations.email })
						.from(invitations)
						.where(
							and(
								eq(invitations.id, digest(token)),
								gt(invitations.expiresAt, new Date()),
							),
						)
				: [];
			return Response.json(
				{
					providers: [
						...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
							? ["github"]
							: []),
						...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
							? ["google"]
							: []),
					],
					emailRecovery: accountEmail.enabled,
					invitation: invite ?? null,
				},
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (
			new URL(request.url).pathname.endsWith("/sign-up/email") &&
			request.method === "POST"
		) {
			const body = await authJsonBody(request);
			if (body instanceof Response) return body;
			if (body.setupToken !== undefined) return setupSignUp(request, body);
			const token = String(
				body.invitationToken ?? invitationCookie(request) ?? "",
			);
			const email = (
				String(body.email ?? "").trim() || `${digest(token)}@users.invalid`
			).toLowerCase();
			const {
				rows: [policy],
			} = await pool.query(
				"select \"registrationPolicy\" from instance_settings where id='instance'",
			);
			if (!token && policy?.registrationPolicy === "open") {
				return registration.run({ email, token: "" }, () =>
					auth.handler(jsonAuthRequest(request, { ...body, email })),
				);
			}
			if (!token)
				return Response.json(
					{ message: "A valid invitation is required" },
					{ status: 403 },
				);
			const [invite] = await db
				.select()
				.from(invitations)
				.where(
					and(
						eq(invitations.id, digest(token)),
						gt(invitations.expiresAt, new Date()),
					),
				);
			if (!invite || (invite.email && invite.email.toLowerCase() !== email))
				return Response.json(
					{ message: "A valid invitation is required" },
					{ status: 403 },
				);
			const forwarded = jsonAuthRequest(request, { ...body, email });
			return registration.run({ email, token }, () => auth.handler(forwarded));
		}
		return auth.handler(request);
	}
	/** The first account of a fresh local instance, created through its one-time setup link
	 * (setup-link.ts) as the instance operator, then signed in. */
	async function setupSignUp(request: Request, body: Record<string, unknown>) {
		const refused = () =>
			Response.json(
				{
					code: "SETUP_LINK_UNAVAILABLE",
					message: "This setup link was already used or has expired",
				},
				{ status: 403, headers: { "Cache-Control": "no-store" } },
			);
		if (request.headers.get("origin") !== env.BETTER_AUTH_URL)
			return new Response("Invalid origin", { status: 403 });
		// The same rule `start` used to print the link, against the address the server binds.
		if (
			!offersSetupLink(
				env.BETTER_AUTH_URL,
				process.env.NITRO_HOST || process.env.HOST || "",
			)
		)
			return refused();
		const input = z
			.object({
				setupToken: z.string().max(200),
				email: z.email().max(320),
				// The sign-up rules (packages/auth): 12 to 128 characters, not only spaces.
				password: z
					.string()
					.min(12)
					.max(128)
					.refine((value) => !!value.trim()),
			})
			.safeParse({
				...body,
				email: String(body.email ?? "")
					.trim()
					.toLowerCase(),
			});
		if (!input.success)
			return Response.json(
				{
					message: "Enter a valid email and a password of 12 to 128 characters",
				},
				{ status: 400 },
			);
		const { setupToken, email, password } = input.data;
		if (!(await setupLinkUsable(pool, setupToken))) return refused();
		const created = await createSetupAccount(pool, setupToken, {
			email,
			// The setup form asks only for email and password.
			name: email.split("@")[0] || email,
			passwordHash: await hashPassword(password),
		}).catch(() => undefined);
		if (!created) return refused();
		if (sendVerificationEmail) {
			// The link ordinary sign-up sends (Better Auth's /verify-email, valid one hour).
			const token = await createEmailVerificationToken(
				env.BETTER_AUTH_SECRET,
				email,
			);
			await sendVerificationEmail({
				user: { id: created, email },
				token,
				url: `${env.BETTER_AUTH_URL}/api/auth/verify-email?token=${token}&callbackURL=${encodeURIComponent("/")}`,
			}).catch(() => console.error("Verification email could not be queued"));
		}
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		const signedIn = await auth
			.handler(
				new Request(new URL("/api/auth/sign-in/email", request.url), {
					method: "POST",
					headers,
					body: JSON.stringify({ email, password }),
					signal: request.signal,
				}),
			)
			.catch(() => undefined);
		if (signedIn?.ok) return signedIn;
		// The account exists and the link is spent: the person signs in on the sign-in page.
		await signedIn?.body?.cancel();
		return Response.json(
			{
				code: "SETUP_ACCOUNT_CREATED",
				message: "Your account was created. Sign in to continue.",
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
	async function actorFromRequest(request: Request): Promise<Actor> {
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) throw new ORPCError("UNAUTHORIZED");
		await active(session.user.id);
		return {
			userId: session.user.id,
			scopeId: session.user.id,
			sessionId: session.session.id,
		};
	}
	const operatorService = createOperatorService(pool, {
		accounts,
		baseURL: env.BETTER_AUTH_URL,
		revokeUserConnections,
	});
	const telemetry = createTelemetryService(pool, {
		destination: process.env.TOOLSTILE_TELEMETRY_URL,
	});
	const instanceRouter = {
		...createApprovalRouter(),
		...createToolReviewRouter(),
		...createConnectorRouter(connectorService),
		...createCommonRouter(),
		...createAccountRouter(),
		...createAllAgentGrantRouter(),
		...createOperatorRouter(operatorService),
		...createLocalCommandRouter(addLocalCommand),
		...createSetupRouter({
			pool,
			services,
			authorize: (actor) => active(actor.userId),
			runtime: (actor, id) => userRuntime(actor, "Setup verification", id),
		}),
	};
	const handleRpc = createRpcHandler<
		Actor,
		{
			actor: Actor;
			services: typeof services;
			dashboardSession: boolean;
		}
	>({
		router: instanceRouter,
		prefix: "/api/rpc",
		origin: env.BETTER_AUTH_URL,
		resolveActor: actorFromRequest,
		context: (actor, request) => ({
			actor,
			services,
			dashboardSession: !request.headers.has("authorization"),
		}),
		mapError: (error) => rpcCallerError(error),
	});
	const gateway = createMcpHttpHandler({
		origin: env.BETTER_AUTH_URL,
		auth,
		resolveAuthorization: async (input) => {
			if (!("token" in input))
				return oauthAuthorization(input.userId, input.referenceId);
			const [row] = await db
				.select({ auth: authorizations, agent: agents, device: devices })
				.from(authorizations)
				.innerJoin(agents, eq(authorizations.agentId, agents.id))
				.innerJoin(devices, eq(agents.deviceId, devices.id))
				.where(eq(authorizations.tokenHash, digest(input.token)));
			return row;
		},
		resolveRuntime: async (row) => {
			await active(row.agent.ownerId);
			return userRuntime(
				{ userId: row.agent.ownerId, scopeId: row.agent.ownerId },
				row.agent.label,
				row.agent.id,
				undefined,
				"agent",
			);
		},
		handle: (request, current) => mcpGateway.handle(request, current),
		mapError: (_error, mode) => {
			if (mode === "oauth")
				return new Response("Agent access revoked or unavailable", {
					status: 403,
				});
			return Response.json(
				{
					jsonrpc: "2.0",
					error: { code: -32603, message: "Gateway request failed" },
					id: null,
				},
				{ status: 500 },
			);
		},
	});
	async function oauthAuthorization(userId: string, referenceId: string) {
		await active(userId);
		const [row] = await db
			.select({ auth: authorizations, agent: agents, device: devices })
			.from(authorizations)
			.innerJoin(agents, eq(authorizations.agentId, agents.id))
			.innerJoin(devices, eq(agents.deviceId, devices.id))
			.where(
				and(eq(authorizations.id, referenceId), eq(agents.ownerId, userId)),
			);
		if (
			!row ||
			row.auth.revokedAt ||
			row.device.revokedAt ||
			(row.auth.expiresAt && row.auth.expiresAt <= new Date())
		)
			throw denied();
		return row;
	}
	const agentOAuth = createAgentConsentHandler<Actor>({
		cookiePrefix: auth.options.advanced?.cookiePrefix,
		clientName: createOAuthClientNameResolver(pool),
		browserDevice: createBrowserDeviceStore(pool),
		origin: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		session: (request) => auth.api.getSession({ headers: request.headers }),
		resolveActor: async (_request, session) => {
			await active(session.user.id);
			return {
				userId: session.user.id,
				scopeId: session.user.id,
				sessionId: session.session.id,
			};
		},
		list: async (actor) => {
			const snapshot = await services.snapshot(actor);
			return {
				devices: snapshot.devices,
				agents: snapshot.agents.filter(
					(a) => !a.expiresAt || new Date(a.expiresAt) > new Date(),
				),
			};
		},
		addDevice: (actor, label) => services.addDevice(actor, label),
		addAgent: (actor, input) => services.addAgent(actor, input),
		resolveReference: async (actor, id) => {
			await ownAgent(actor, id);
			const [authorization] = await db
				.select()
				.from(authorizations)
				.where(eq(authorizations.agentId, id));
			await oauthAuthorization(actor.userId, authorization.id);
			return authorization.id;
		},
		describeReference: async (actor, id) => {
			const row = await oauthAuthorization(actor.userId, id);
			return { agentLabel: row.agent.label, deviceLabel: row.device.label };
		},
		selection: oauthSelection,
	});
	/** `toolstile auth login` and `toolstile mcp setup`: each account's own devices and agents. */
	const handleCli = createCliHttpHandler({
		auth,
		pool,
		origin: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		mcpUrl: `${env.BETTER_AUTH_URL}/mcp`,
		services,
		// Requests act for the signed-in account; other parameters are ignored.
		actor: (request) => actorFromRequest(request),
		approver: async (session) => {
			await active(session.user.id);
			return {
				userId: session.user.id,
				scopeId: session.user.id,
				sessionId: session.session.id,
			};
		},
		// The CLI reads one response shape from every server; accounts here have no workspaces.
		account: async (session) => {
			await active(session.user.id);
			return { edition: "self-hosted", workspaces: [] };
		},
		fences: (actor) => [accountFence(actor.userId)],
		agents: {
			async list(actor, deviceId) {
				const { rows } = await pool.query<{ id: string; label: string }>(
					`select a.id,a.label from agents a join authorizations z on z."agentId"=a.id join devices d on d.id=a."deviceId"
					where a."ownerId"=$1 and a."deviceId"=$2 and z."revokedAt" is null and d."revokedAt" is null
					order by a."createdAt",a.id`,
					[actor.userId, deviceId],
				);
				return rows;
			},
			async find(actor, id) {
				const {
					rows: [row],
				} = await pool.query<{
					id: string;
					label: string;
					device: string | null;
				}>(
					`select a.id,a.label,d.label as device from agents a left join devices d on d.id=a."deviceId"
					where a.id=$1 and a."ownerId"=$2`,
					[id, actor.userId],
				);
				return row;
			},
		},
	});
	const upstreamHttp = createUpstreamOAuthHttpHandlers({
		session: (request) => auth.api.getSession({ headers: request.headers }),
		metadata: () => upstreamOAuth.metadata(),
		finish: (identity, state, code, issuer) =>
			upstreamOAuth.finish(identity, state, code, issuer),
		// The connection id lets the dashboard highlight it; provider code and state never follow.
		successLocation: ({ connectionId }) =>
			`/app/connections?oauth=connected&oauthConnection=${encodeURIComponent(connectionId)}`,
	});
	const upstreamClientMetadata = upstreamHttp.metadata;
	const upstreamOAuthCallback = upstreamHttp.callback;
	// Persistent deadlines/outbox rows survive restarts. Multiple processes safely share the scans.
	// Each step runs on its own so one failure doesn't stall the rest; logs carry only the
	// step name and error class/message, never payloads.
	const maintenanceSteps: [string, () => Promise<unknown>][] = [
		["debug cleanup", () => debug.cleanup()],
		[
			"approval cleanup",
			async () => {
				const {
					rows: [retention],
				} = await pool.query<{
					activityRetentionDays: number;
				}>(
					'select "activityRetentionDays" from instance_settings where id=$1',
					["instance"],
				);
				await approvals.cleanup(retention?.activityRetentionDays ?? 30);
			},
		],
		["connector request cleanup", () => cleanupConnectorRequests(pool)],
		["session purge", () => purgeExpiredSessions(pool)],
		["OAuth purge", () => purgeExpiredOAuth(pool)],
		["telemetry", () => telemetry.tick()],
		["account purge", () => accounts.purgeExpired()],
		["account email", () => accountEmail.flush()],
	];
	async function runMaintenance() {
		for (const [step, run] of maintenanceSteps) {
			try {
				await run();
			} catch (error) {
				const kind = error instanceof Error ? error.name : typeof error;
				const message =
					error instanceof Error
						? error.message.replace(/\s+/g, " ").slice(0, 200)
						: "";
				console.error(
					`Maintenance step "${step}" failed (${kind}${message ? `: ${message}` : ""}); retrying on the next scan`,
				);
			}
		}
	}
	let maintenance: Promise<void> | undefined;
	let stopping = false;
	const accountMaintenance = process.env.VITEST
		? undefined
		: setInterval(() => {
				if (maintenance || stopping) return;
				maintenance = runMaintenance().finally(() => {
					maintenance = undefined;
				});
			}, 60000);
	accountMaintenance?.unref();
	(
		import.meta as ImportMeta & {
			hot?: {
				dispose(callback: () => void): void;
			};
		}
	).hot?.dispose(() => {
		if (accountMaintenance) clearInterval(accountMaintenance);
		void upstreamOAuth.close();
	});

	let closing: Promise<void> | undefined;
	let streamsClosing: Promise<void> | undefined;
	const closeStreams = () => (streamsClosing ??= mcpGateway.close());
	function stopMaintenance() {
		stopping = true;
		if (accountMaintenance) clearInterval(accountMaintenance);
	}
	return {
		async ready() {
			const { rows } = await readinessPool.query(
				"select (select count(*) from __toolstile_migrations) as migrations, (select count(*) from instance_settings) as settings",
			);
			if (!Number(rows[0]?.migrations))
				throw new Error("Schema is not initialized");
		},
		stopMaintenance,
		closeStreams,
		close: () =>
			(closing ??= (async () => {
				stopMaintenance();
				let failed = false;
				const attempt = async (work: () => Promise<unknown> | undefined) => {
					try {
						await work();
					} catch {
						failed = true;
					}
				};
				await attempt(closeStreams);
				await attempt(closeLocalCommands);
				await attempt(() => maintenance);
				await attempt(() => upstreamOAuth.close());
				await attempt(() => readinessPool.end());
				if (readinessPool !== pool) await attempt(() => pool.end());
				if (failed) throw new Error("Runtime cleanup failed");
			})()),
		db,
		pool,
		storage,
		accounts,
		registration,
		auth,
		debug,
		services,
		handleAuth,
		actorFromRequest,
		operatorService,
		instanceRouter,
		handleRpc,
		gateway,
		agentOAuth,
		handleCli,
		upstreamClientMetadata,
		upstreamOAuthCallback,
		runMaintenance,
	};
}

let instance: ReturnType<typeof createInstanceRuntime> | undefined;
export function instanceRuntime(
	options?: Parameters<typeof createInstanceRuntime>[0],
) {
	instance ??= createInstanceRuntime(options);
	registerLifecycleRuntime(instance);
	return instance;
}
function lazy<T extends object>(load: () => T): T {
	return new Proxy({} as T, {
		ownKeys: () => Reflect.ownKeys(load()),
		getOwnPropertyDescriptor(_target, key) {
			const descriptor = Reflect.getOwnPropertyDescriptor(load(), key);
			return descriptor ? { ...descriptor, configurable: true } : undefined;
		},
		has: (_target, key) => Reflect.has(load(), key),
		set: (_target, key, value) => Reflect.set(load(), key, value),
		get(_target, key) {
			const owner = load();
			const value = Reflect.get(owner, key);
			return typeof value === "function" ? value.bind(owner) : value;
		},
	});
}
export const db = lazy(() => instanceRuntime().db);
export const pool = lazy(() => instanceRuntime().pool);
export const storage = lazy(() => instanceRuntime().storage);
export const accounts = lazy(() => instanceRuntime().accounts);
export const registration = lazy(() => instanceRuntime().registration);
export const auth = lazy(() => instanceRuntime().auth);
export const debug = lazy(() => instanceRuntime().debug);
export const services = lazy(() => instanceRuntime().services);
export const handleAuth: ReturnType<
	typeof createInstanceRuntime
>["handleAuth"] = (...args) => instanceRuntime().handleAuth(...args);
export const actorFromRequest: ReturnType<
	typeof createInstanceRuntime
>["actorFromRequest"] = (...args) =>
	instanceRuntime().actorFromRequest(...args);
export const operatorService = lazy(() => instanceRuntime().operatorService);
export const instanceRouter = lazy(() => instanceRuntime().instanceRouter);
export const handleRpc: ReturnType<
	typeof createInstanceRuntime
>["handleRpc"] = (...args) => instanceRuntime().handleRpc(...args);
export const gateway: ReturnType<typeof createInstanceRuntime>["gateway"] = (
	...args
) => instanceRuntime().gateway(...args);
export const agentOAuth: ReturnType<
	typeof createInstanceRuntime
>["agentOAuth"] = (...args) => instanceRuntime().agentOAuth(...args);
export const handleCli: ReturnType<
	typeof createInstanceRuntime
>["handleCli"] = (...args) => instanceRuntime().handleCli(...args);
export const upstreamClientMetadata: ReturnType<
	typeof createInstanceRuntime
>["upstreamClientMetadata"] = (...args) =>
	instanceRuntime().upstreamClientMetadata(...args);
export const upstreamOAuthCallback: ReturnType<
	typeof createInstanceRuntime
>["upstreamOAuthCallback"] = (...args) =>
	instanceRuntime().upstreamOAuthCallback(...args);
export const runMaintenance: ReturnType<
	typeof createInstanceRuntime
>["runMaintenance"] = (...args) => instanceRuntime().runMaintenance(...args);
