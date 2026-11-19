import { createHmac, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Pool } from "@toolstile/database/sql";
import { type Fence, transaction } from "@toolstile/database/transaction";
import { BodyReadError, readJsonBody } from "@toolstile/gateway/request-body";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deviceAuthorization } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth/types";
import { z } from "zod";
import { failureReason } from "./failure";
import { liveSession } from "./session-check";

/** The only client allowed to request device codes. */
const CLI_CLIENT_ID = "toolstile-cli";

/**
 * `toolstile auth login` (device authorization, RFC 8628): the CLI polls while a signed-in
 * browser approves its code at `verificationUri`. The library's own lookup, approval and denial
 * routes stay disabled (see UNUSED_AUTH_PATHS); `/api/cli/lookup`, `/approve` and `/deny` make
 * them for a signed-in account only.
 * When the CLI redeems an approved code, its new session takes over the device link.
 */
export function cliDevicePlugins(options: {
	pool: Pick<Pool, "query">;
	verificationUri: string;
}) {
	const sessions = {
		id: "toolstile-cli-device-sessions",
		hooks: {
			after: [
				{
					matcher: (context) => context.path === "/device/token",
					handler: createAuthMiddleware(async (ctx) => {
						const created = ctx.context.newSession;
						const code = (ctx.body as { device_code?: unknown } | undefined)
							?.device_code;
						if (!created?.session?.id || typeof code !== "string") return;
						await options.pool.query(
							`update cli_device_links set "sessionId"=$1 where "deviceCode"=$2 and "userId"=$3 and "sessionId" is null`,
							[created.session.id, code, created.user.id],
						);
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
	return [
		deviceAuthorization({
			expiresIn: "10m",
			interval: "5s",
			verificationUri: options.verificationUri,
			validateClient: (clientId) => clientId === CLI_CLIENT_ID,
		}),
		sessions,
	];
}

const label = z
	.string()
	// oxlint-disable-next-line eslint/no-control-regex -- strip control characters
	.transform((value) => value.replace(/[\u0000-\u001f\u007f]/g, "").trim())
	.pipe(z.string().min(1).max(100));
const id = z.string().min(1).max(100);
const parameters = z.record(z.string(), z.unknown());
const deviceInput = z.object({
	id: id.optional(),
	label,
	/** Rename the saved device to `label` instead of keeping its current name. */
	rename: z.boolean().optional(),
});
const agentInput = z.object({ deviceId: id, label });
/** `accountId` is the account the page showed; a request from another account is refused. */
const codeInput = z.object({
	userCode: z.string().max(32),
	accountId: z.string().min(1).max(256),
});
const approveInput = codeInput.extend({ deviceName: label });
/** Stored user codes are upper case, without the dash the page shows. */
const normalizedCode = (value: string) =>
	value.toUpperCase().replace(/[^A-Z0-9]/g, "");
class CliError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
const signIn = () => new CliError(401, "Sign in with toolstile auth login");
const invalidCode = () =>
	new CliError(
		400,
		"This code is not valid or has expired. Run toolstile auth login again.",
	);
/** Code lookups per account and window: enough for repeated sign-ins, far too few to guess. */
const LOOKUPS = { max: 10, windowMs: 600_000 };
/** A per-process fixed-window limit by account, for a host without a shared limiter. */
function memoryLimit() {
	const windows = new Map<string, { count: number; resetsAt: number }>();
	return async (userId: string) => {
		const now = Date.now();
		for (const [key, entry] of windows)
			if (entry.resetsAt <= now) windows.delete(key);
		const entry = windows.get(userId) ?? {
			count: 0,
			resetsAt: now + LOOKUPS.windowMs,
		};
		if (entry.count >= LOOKUPS.max)
			throw new CliError(
				429,
				"Too many attempts. Wait a minute and try again.",
			);
		entry.count++;
		windows.set(userId, entry);
	};
}

type CliSession = {
	user: { id: string; email: string; name: string };
	session: { id: string; expiresAt: Date };
};
type CliActor = { userId: string; sessionId?: string };
/** The device and agent changes the CLI makes, through the application's own services. */
interface CliServices<A> {
	addDevice(actor: A, label: string): Promise<{ id: string }>;
	renameDevice(actor: A, input: { id: string; label: string }): Promise<void>;
	addAgent(
		actor: A,
		input: { deviceId: string; label: string; expiresInDays: null },
	): Promise<{ id: string; token: string }>;
	revokeAgent(actor: A, id: string): Promise<void>;
}
interface CliHttpOptions<A extends CliActor, Account extends object> {
	auth: {
		$context: Promise<{ authCookies: { sessionToken: { name: string } } }>;
		api: {
			getSession(input: { headers: Headers }): Promise<CliSession | null>;
		};
	};
	pool: Pool;
	/** The application origin; the browser routes accept only same-origin requests. */
	origin: string;
	/** The auth secret that signs session cookies. */
	secret: string;
	/** The gateway URL agents use, reported by `/account`. */
	mcpUrl: string;
	services: CliServices<A>;
	/**
	 * The caller of a CLI request. `request` carries the CLI's session as a cookie; `input` holds
	 * the request's parameters (its query, or its JSON body).
	 */
	actor(request: Request, input: Record<string, unknown>): Promise<A>;
	/** The signed-in browser account approving a code. */
	approver(session: CliSession, request: Request): Promise<A>;
	/** Fields `/account` adds for the signed-in account. */
	account(session: CliSession, request: Request): Promise<Account>;
	/** Fences ordering an approval with changes that revoke the account's sessions. */
	fences(actor: A): Fence[];
	/**
	 * Charges one code lookup to the account, throwing once its limit is reached. Defaults to an
	 * in-process limit of ten lookups per ten minutes per account.
	 */
	lookupLimit?(userId: string): Promise<void>;
	agents: {
		/** The caller's live agents on one of their devices. */
		list(actor: A, deviceId: string): Promise<{ id: string; label: string }[]>;
		/** One of the caller's agents, by the ID `list` and creation return. */
		find(
			actor: A,
			id: string,
		): Promise<
			{ id: string; label: string; device: string | null } | undefined
		>;
	};
	/** Runs after an agent change committed; a failure never fails the response. */
	agentChanged?(
		actor: A,
		change: {
			event: "connected" | "disconnected";
			agent: string;
			device: string | null;
		},
	): Promise<void>;
}

/**
 * `/api/cli/*` for `toolstile auth login` and `toolstile mcp setup`. The CLI holds the session
 * token from device authorization and sends it as a bearer token. Only these routes accept it:
 * it is re-signed into a session cookie here, so the dashboard API and Better Auth's own routes
 * still require a browser cookie. The exceptions are `/lookup`, `/approve` and `/deny`, which the
 * approval page calls with its own browser session.
 */
export function createCliHttpHandler<
	A extends CliActor,
	Account extends object,
>(options: CliHttpOptions<A, Account>) {
	const { auth, pool, services } = options;
	const lookupLimit = options.lookupLimit ?? memoryLimit();
	async function sessionHeaders(request: Request) {
		const token = request.headers
			.get("authorization")
			?.match(/^Bearer ([A-Za-z0-9_-]{16,256})$/i)?.[1];
		if (!token) throw signIn();
		const { authCookies } = await auth.$context;
		const signature = createHmac("sha256", options.secret)
			.update(token)
			.digest("base64");
		const headers = new Headers({
			cookie: `${authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`,
		});
		return { headers, token };
	}
	async function actor(request: Request, input: Record<string, unknown>) {
		const { headers } = await sessionHeaders(request);
		try {
			return await options.actor(new Request(request.url, { headers }), input);
		} catch (error) {
			if (error instanceof ORPCError && error.status === 401) throw signIn();
			throw error;
		}
	}
	const agentChanged = async (
		current: A,
		change: Parameters<NonNullable<typeof options.agentChanged>>[1],
	) => {
		try {
			await options.agentChanged?.(current, change);
		} catch (error) {
			console.error("CLI agent change record failed", failureReason(error));
		}
	};
	async function account(request: Request) {
		const { headers } = await sessionHeaders(request);
		const session = await auth.api.getSession({ headers });
		if (!session) throw signIn();
		const extra = await options.account(session, request);
		// The device named when this sign-in was approved, while it still exists.
		const {
			rows: [device],
		} = await pool.query<{ id: string; label: string }>(
			`select d.id,d.label from cli_device_links l join devices d on d.id=l."deviceId"
			where l."sessionId"=$1 and d."ownerId"=$2 and d."revokedAt" is null`,
			[session.session.id, session.user.id],
		);
		return {
			email: session.user.email,
			name: session.user.name,
			expiresAt: session.session.expiresAt,
			device: device ?? null,
			// The gateway URL agents use; it can be on another host than this API.
			mcpUrl: options.mcpUrl,
			...extra,
		};
	}
	/** Reuse the CLI's saved device while it still exists; otherwise create one. */
	async function device(request: Request, raw: Record<string, unknown>) {
		const input = deviceInput.parse(raw);
		const current = await actor(request, raw);
		if (input.id) {
			const {
				rows: [existing],
			} = await pool.query<{ id: string; label: string }>(
				'select id,label from devices where id=$1 and "ownerId"=$2 and "revokedAt" is null',
				[input.id, current.userId],
			);
			if (existing && input.rename && existing.label !== input.label) {
				await services.renameDevice(current, {
					id: existing.id,
					label: input.label,
				});
				return { id: existing.id, label: input.label };
			}
			if (existing) return { id: existing.id, label: existing.label };
		}
		const created = await services.addDevice(current, input.label);
		return { id: created.id, label: input.label };
	}
	/**
	 * The signed-in browser account behind a same-origin request from the approval page, and the
	 * request's input. The account must still be the one the page showed: signing in to another
	 * account in another tab must not decide a code for it.
	 */
	async function browserRequest<T extends { accountId: string }>(
		request: Request,
		schema: z.ZodType<T>,
	) {
		if (request.headers.get("origin") !== options.origin)
			throw new CliError(403, "Invalid origin");
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) throw new CliError(401, "Sign in to approve this code");
		const input = schema.parse(await readJsonBody(request, 16 * 1024));
		if (input.accountId !== session.user.id)
			throw new CliError(
				409,
				"You signed in as a different account. Reload this page.",
			);
		return { session, input };
	}
	/**
	 * The approval page's first step: binds a pending, unexpired code to the signed-in account
	 * that looks it up first, so only that account can decide it. Signed-in only and limited per
	 * account, so neither anonymous traffic nor another account can use up the quota.
	 */
	async function lookup(request: Request) {
		const { session, input } = await browserRequest(request, codeInput);
		const userCode = normalizedCode(input.userCode);
		await lookupLimit(session.user.id);
		await pool.query(
			`update device_code set "userId"=$1 where "userCode"=$2 and "clientId"=$3 and status='pending'
			and "userId" is null and "expiresAt">clock_timestamp()`,
			[session.user.id, userCode, CLI_CLIENT_ID],
		);
		const {
			rows: [code],
		} = await pool.query<{ status: string }>(
			`select status from device_code where "userCode"=$1 and "clientId"=$2 and "userId"=$3
			and "expiresAt">clock_timestamp()`,
			[userCode, CLI_CLIENT_ID, session.user.id],
		);
		if (!code) throw invalidCode();
		return { status: code.status };
	}
	/** Denies a pending, unexpired code this account looked up; any other code is unchanged. */
	async function deny(request: Request) {
		const { session, input } = await browserRequest(request, codeInput);
		const userCode = normalizedCode(input.userCode);
		const { rowCount } = await pool.query(
			`update device_code set status='denied' where "userCode"=$1 and "userId"=$2 and "clientId"=$3
			and status='pending' and "expiresAt">clock_timestamp()`,
			[userCode, session.user.id, CLI_CLIENT_ID],
		);
		if (!rowCount) throw invalidCode();
	}
	/**
	 * Approval from the signed-in browser. Names the machine: an existing device with that name
	 * is reused, otherwise one is created. The CLI learns it from `/account` once it redeems the
	 * code.
	 */
	async function approve(request: Request) {
		const { session, input } = await browserRequest(request, approveInput);
		const userCode = normalizedCode(input.userCode);
		// A cheap check first, so a code that cannot be approved provisions nothing for the
		// approver; the guarded update below is the one that counts.
		const {
			rows: [eligible],
		} = await pool.query(
			`select 1 from device_code where "userCode"=$1 and "clientId"=$2 and "userId"=$3
			and status='pending' and "expiresAt">clock_timestamp()`,
			[userCode, CLI_CLIENT_ID, session.user.id],
		);
		if (!eligible) throw invalidCode();
		const current = await options.approver(session, request);
		// One transaction behind the account's fences: the session is still live, only a code
		// still pending, unexpired and bound to this account moves to approved, and only that
		// approval names the device and records the link, so a losing approval changes nothing.
		// A recovery, which denies the account's codes under the same fence, is ordered with it.
		const device = await transaction(
			pool,
			async (tx) => {
				if (current.sessionId && !(await liveSession(tx, current)))
					throw new ORPCError("FORBIDDEN", {
						message: "Unavailable or access denied",
					});
				const {
					rows: [code],
				} = await tx.query<{ deviceCode: string }>(
					`update device_code set status='approved' where "userCode"=$1 and "userId"=$2 and "clientId"=$3
					and status='pending' and "expiresAt">clock_timestamp() returning "deviceCode"`,
					[userCode, current.userId, CLI_CLIENT_ID],
				);
				if (!code) return undefined;
				const {
					rows: [existing],
				} = await tx.query<{ id: string; label: string }>(
					`select id,label from devices where "ownerId"=$1 and "revokedAt" is null and lower(label)=lower($2)
					order by "createdAt" limit 1`,
					[current.userId, input.deviceName],
				);
				const named = existing
					? { id: existing.id, label: existing.label }
					: { id: randomUUID(), label: input.deviceName };
				if (!existing)
					await tx.query(
						'insert into devices(id,"ownerId",label) values($1,$2,$3)',
						[named.id, current.userId, named.label],
					);
				await tx.query(
					`insert into cli_device_links("deviceCode","userId","deviceId") values($1,$2,$3)
					on conflict ("deviceCode") do update set "deviceId"=excluded."deviceId"`,
					[code.deviceCode, current.userId, named.id],
				);
				return named;
			},
			{ fences: options.fences(current) },
		);
		if (!device) throw invalidCode();
		return device;
	}
	return async function handleCli(request: Request) {
		const headers = { "Cache-Control": "no-store" };
		try {
			const url = new URL(request.url);
			const path = url.pathname.replace(/^\/api\/cli/, "");
			const query = Object.fromEntries(url.searchParams);
			if (request.method === "GET" && path === "/account")
				return Response.json(await account(request), { headers });
			if (request.method === "POST" && path === "/lookup")
				return Response.json(await lookup(request), { headers });
			if (request.method === "POST" && path === "/approve")
				return Response.json({ device: await approve(request) }, { headers });
			if (request.method === "POST" && path === "/deny") {
				await deny(request);
				return new Response(null, { status: 204, headers });
			}
			if (request.method === "POST" && path === "/sign-out") {
				const { token } = await sessionHeaders(request);
				await pool.query("delete from session where token=$1", [token]);
				return new Response(null, { status: 204, headers });
			}
			if (request.method === "POST" && path === "/device")
				return Response.json(
					await device(
						request,
						parameters.parse(await readJsonBody(request, 16 * 1024)),
					),
					{ headers },
				);
			if (request.method === "GET" && path === "/agents") {
				const current = await actor(request, query);
				return Response.json(
					{
						agents: await options.agents.list(
							current,
							id.parse(url.searchParams.get("deviceId")),
						),
					},
					{ headers },
				);
			}
			if (request.method === "POST" && path === "/agents") {
				const raw = parameters.parse(await readJsonBody(request, 16 * 1024));
				const input = agentInput.parse(raw);
				const current = await actor(request, raw);
				// Read before the agent exists: once it commits, nothing may fail the
				// response that carries its one-time token. addAgent rechecks the device.
				const {
					rows: [device],
				} = await pool.query<{ label: string }>(
					'select label from devices where id=$1 and "ownerId"=$2',
					[input.deviceId, current.userId],
				);
				const created = await services.addAgent(current, {
					deviceId: input.deviceId,
					label: input.label,
					expiresInDays: null,
				});
				await agentChanged(current, {
					event: "connected",
					agent: input.label,
					device: device?.label ?? null,
				});
				return Response.json(
					{ id: created.id, label: input.label, token: created.token },
					{ status: 201, headers },
				);
			}
			const agent = id.safeParse(
				path.match(/^\/agents\/([A-Za-z0-9-]+)$/)?.[1],
			).data;
			if (request.method === "DELETE" && agent) {
				const current = await actor(request, query);
				const owned = await options.agents.find(current, agent);
				if (!owned) throw new CliError(404, "Agent not found");
				await services.revokeAgent(current, owned.id);
				await agentChanged(current, {
					event: "disconnected",
					agent: owned.label,
					device: owned.device,
				});
				return new Response(null, { status: 204, headers });
			}
			throw new CliError(404, "Not found");
		} catch (error) {
			const [status, message] =
				error instanceof CliError || error instanceof BodyReadError
					? [error.status, error.message]
					: error instanceof z.ZodError || error instanceof SyntaxError
						? [400, "Invalid request"]
						: error instanceof ORPCError && error.status < 500
							? [error.status, error.message]
							: error instanceof APIError && error.statusCode < 500
								? [error.statusCode, error.message]
								: [500, "Request failed. Try again."];
			if (status >= 500)
				console.error("CLI request failed", failureReason(error));
			return Response.json({ message }, { status, headers });
		}
	};
}
