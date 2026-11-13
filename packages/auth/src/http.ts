import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Pool } from "@toolstile/database/sql";
import type { Runtime } from "@toolstile/gateway";
import { BodyReadError, readJsonBody } from "@toolstile/gateway/request-body";
import { z } from "zod";
import { digest } from "./digest";
import { failureReason } from "./failure";
import { requireMcpAuth, validatedOAuthFlow } from "./oauth";

class ConsentInputError extends Error {
}
type SelectionInput = {
    userId: string;
    sessionId: string;
    flowKey: string;
};
/** The application supplies storage for independently bound browser flows. */
export function createOAuthSelectionStore(storage: Pick<Pool, "query">) {
    const id = (input: SelectionInput) => digest(`${input.userId}:${input.sessionId}:${input.flowKey}`);
    return {
        async lookup(input: SelectionInput): Promise<string | undefined> {
            const { rows } = await storage.query<{
                referenceId: string;
            }>('select "referenceId" from oauth_flow_selection where id=$1 and "expiresAt">$2', [id(input), new Date()]);
            return rows[0]?.referenceId;
        },
        async save(input: SelectionInput & {
            referenceId: string;
        }) {
            await storage.query('insert into oauth_flow_selection (id,"sessionId","userId","referenceId","expiresAt") values ($1,$2,$3,$4,$5) on conflict (id) do update set "referenceId"=excluded."referenceId","expiresAt"=excluded."expiresAt"', [
                id(input),
                input.sessionId,
                input.userId,
                input.referenceId,
                new Date(Date.now() + 600000),
            ]);
        },
    };
}
export type OAuthSession = {
    user: {
        id: string;
        name?: string;
        email?: string;
    };
    session: {
        id: string;
    };
};
const labelInput = z.string().trim().min(1).max(100);
const consentInput = z.object({
    oauth_query: z.string().max(16384),
    agentId: z.string().optional(),
    deviceId: z.string().optional(),
    /** Create a device even when this browser remembers one. */
    newDevice: z.boolean().optional(),
    deviceLabel: labelInput.optional(),
    agentLabel: labelInput.optional(),
    // Preserve older callers while the consent screens migrate.
    label: labelInput.optional(),
});
/** Better Auth persists both registration and CIMD client_name as oauthClient.name. */
export function createOAuthClientNameResolver(storage: Pick<Pool, "query">) {
    return async (clientId: string): Promise<string | null> => {
        const { rows } = await storage.query<{
            name: string | null;
        }>('select name from "oauthClient" where "clientId"=$1 and disabled is not true', [clientId]);
        return rows[0]?.name?.trim() || null;
    };
}
/** Browser tokens are opaque and stored only as digests, scoped to the live owner. */
export function createBrowserDeviceStore(storage: Pick<Pool, "query">) {
    return {
        async lookup(userId: string, hash: string): Promise<string | null> {
            const { rows } = await storage.query<{
                id: string;
            }>('select id from devices where "ownerId"=$1 and "browserKeyHash"=$2 and "revokedAt" is null', [userId, hash]);
            return rows[0]?.id ?? null;
        },
        async bind(userId: string, deviceId: string, hash: string) {
            const result = await storage.query('update devices set "browserKeyHash"=$3 where "ownerId"=$1 and id=$2 and "revokedAt" is null returning id', [userId, deviceId, hash]);
            if (!result.rows.length)
                throw new ConsentInputError("Device unavailable");
        },
    };
}
export function detectedDeviceLabel(headers: Headers) {
    const ua = headers.get("user-agent") ?? "";
    const platform = headers
        .get("sec-ch-ua-platform")
        ?.replaceAll('"', "")
        .trim();
    const families: [
        RegExp,
        string
    ][] = [
        [/iPad/i, "iPad"],
        [/iPhone|iPod/i, "iPhone"],
        [/Android/i, "Android"],
        [/CrOS|Chrome\s?OS/i, "ChromeOS"],
        [/Mac/i, "Mac"],
        [/Windows/i, "Windows"],
        [/Linux/i, "Linux"],
    ];
    const os = families.find(([match]) => match.test(platform ?? ""))?.[1] ??
        families.find(([match]) => match.test(ua))?.[1] ??
        "Device";
    const browserUa = `${ua} ${headers.get("sec-ch-ua") ?? ""}`;
    const browser = /Edg(?:e|A|iOS)?\/|Microsoft Edge/i.test(browserUa)
        ? "Edge"
        : /OPR\/|Opera\//i.test(browserUa)
            ? "Opera"
            : /Firefox\/|FxiOS\//i.test(browserUa)
                ? "Firefox"
                : /Chrome\/|Chromium|Google Chrome|CriOS\//i.test(browserUa)
                    ? "Chrome"
                    : /Safari\//i.test(browserUa)
                        ? "Safari"
                        : null;
    return browser ? `${os} \u00B7 ${browser}` : os;
}
/** Untrusted display text only: it preselects or names a device, never authorizes one. */
function requestedDeviceLabel(query: string) {
    const label = new URLSearchParams(query)
        .get("device_name")
        // oxlint-disable-next-line eslint/no-control-regex -- strip control characters
        ?.replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 100);
    return label || null;
}
function uniqueLabel(label: string, existing: {
    label: string;
}[]) {
    const labels = new Set(existing.map((entry) => entry.label));
    const base = label.trim().slice(0, 100) || "Agent";
    let candidate = base;
    for (let n = 2; labels.has(candidate); n++) {
        const suffix = ` (${n})`;
        candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    }
    return candidate;
}
type ConsentList = {
    devices: {
        id: string;
        label: string;
    }[];
    agents: {
        id: string;
        label: string;
    }[];
};
export function createAgentConsentHandler<Actor extends {
    userId: string;
}>(deps: {
    origin: string;
    secret: string;
    cookiePrefix?: string;
    session(request: Request): Promise<OAuthSession | null>;
    resolveActor(request: Request, session: OAuthSession): Promise<Actor>;
    list(actor: Actor): Promise<ConsentList>;
    activeLabels?(actor: Actor): Promise<{
        agents: {
            label: string;
        }[];
    }>;
    clientName(clientId: string): Promise<string | null>;
    browserDevice: ReturnType<typeof createBrowserDeviceStore>;
    addDevice(actor: Actor, label: string): Promise<{
        id: string;
    }>;
    addAgent(actor: Actor, input: {
        deviceId: string;
        label: string;
        expiresInDays: null;
    }): Promise<{
        id: string;
    }>;
    resolveReference(actor: Actor, agentId: string): Promise<string>;
    describeReference(actor: Actor, referenceId: string): Promise<{ agentLabel: string; deviceLabel: string }>;
    selection: Pick<ReturnType<typeof createOAuthSelectionStore>, "save" | "lookup">;
}) {
    const cookieName = `${deps.cookiePrefix ?? "toolstile"}-device`;
    return async (request: Request) => {
        try {
            const session = await deps.session(request);
            if (!session)
                return new Response("Sign in required", { status: 401 });
            const actor = await deps.resolveActor(request, session);
            if (!["GET", "POST"].includes(request.method))
                return new Response("Method not allowed", {
                    status: 405,
                    headers: { Allow: "GET, POST" },
                });
            if (request.method === "POST" &&
                request.headers.get("origin") !== deps.origin)
                return new Response("Invalid origin", { status: 403 });
            const body = request.method === "POST"
                ? consentInput.parse(await readJsonBody(request, 64 * 1024))
                : null;
            const query = body?.oauth_query ??
                new URL(request.url).searchParams.get("oauth_query");
            let flowKey: string | undefined;
            if (query !== null)
                flowKey = await validatedOAuthFlow(z.string().max(16384).parse(query), deps.secret).catch(() => {
                    throw new ConsentInputError("Authorization request is invalid or expired. Start sign-in again.");
                });
            const clientId = query
                ? new URLSearchParams(query).get("client_id")
                : null;
            const clientName = clientId ? await deps.clientName(clientId) : null;
            const list = await deps.list(actor);
            const labels = (await deps.activeLabels?.(actor)) ?? list;
            const token = request.headers
                .get("cookie")
                ?.split(";")
                .map((part) => part.trim())
                .find((part) => part.startsWith(`${cookieName}=`))
                ?.slice(cookieName.length + 1);
            // A `device_name` added to the authorization URL by the machine running the agent
            // (for example over SSH) names that machine; this browser is then only the approver.
            const deviceHint = query ? requestedDeviceLabel(query) : null;
            const hinted = deviceHint
                ? (list.devices.find((device) => device.label.toLowerCase() === deviceHint.toLowerCase())?.id ?? null)
                : null;
            const remembered = deviceHint
                ? hinted
                : token && /^[A-Za-z0-9_-]{43}$/.test(token)
                    ? await deps.browserDevice.lookup(actor.userId, digest(token))
                    : null;
            const suggested = {
                agentLabel: uniqueLabel(clientName ?? "Agent", labels.agents),
                deviceLabel: uniqueLabel(deviceHint ?? detectedDeviceLabel(request.headers), list.devices),
                deviceId: remembered,
                clientName,
            };
            const selectedId = flowKey ? await deps.selection.lookup({
                userId: actor.userId, sessionId: session.session.id, flowKey,
            }) : undefined;
            const selected = selectedId ? await deps.describeReference(actor, selectedId) : null;
            if (!body) {
                return Response.json({
                    ...list, suggested,
                    account: { name: session.user.name, email: session.user.email },
                    selected,
                }, { headers: { "Cache-Control": "no-store" } });
            }
            if (!flowKey)
                throw new ConsentInputError("Authorization request is required");
            // A response can be lost after enrollment committed. Reuse only this signed,
            // session-bound selection, validating live ownership again before continuing.
            let agentId = body.agentId;
            let cookie: string | undefined;
            if (!agentId && !selectedId) {
                let deviceId = body.newDevice
                    ? undefined
                    : (body.deviceId ?? remembered);
                if (deviceId && !list.devices.some((device) => device.id === deviceId))
                    throw new ConsentInputError("Device unavailable");
                if (!deviceId)
                    deviceId = (await deps.addDevice(actor, body.deviceLabel ?? suggested.deviceLabel)).id;
                agentId = (await deps.addAgent(actor, {
                    deviceId,
                    label: body.agentLabel ?? body.label ?? suggested.agentLabel,
                    expiresInDays: null,
                })).id;
                if (!deviceHint && deviceId !== remembered) {
                    const browserToken = randomBytes(32).toString("base64url");
                    await deps.browserDevice.bind(actor.userId, deviceId, digest(browserToken));
                    cookie = `${cookieName}=${browserToken}; Max-Age=31536000; HttpOnly; SameSite=Lax; Path=/api/agent-oauth${new URL(deps.origin).protocol === "https:" ? "; Secure" : ""}`;
                }
            }
            const referenceId = agentId ? await deps.resolveReference(actor, agentId) : selectedId!;
            await deps.selection.save({
                userId: actor.userId,
                sessionId: session.session.id,
                flowKey,
                referenceId,
            });
            return Response.json({ ok: true }, {
                headers: {
                    "Cache-Control": "no-store",
                    ...(cookie ? { "Set-Cookie": cookie } : {}),
                },
            });
        }
        catch (error) {
            if (error instanceof BodyReadError)
                return Response.json({ message: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
            return Response.json({
                message: error instanceof ConsentInputError ||
                    (error instanceof ORPCError &&
                        error.status >= 400 &&
                        error.status < 500)
                    ? error.message
                    : error instanceof z.ZodError || error instanceof SyntaxError
                        ? "Invalid authorization request. Check your selection and try again."
                        : "Authorization failed. Try again.",
            }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
    };
}
export function createUpstreamOAuthHttpHandlers<Context>(deps: {
    session(request: Request): Promise<OAuthSession | null>;
    metadata(): unknown;
    finish(identity: {
        userId: string;
        sessionId: string;
    }, state: string, code?: string, issuer?: string): Promise<Context>;
    successLocation(context: Context): string;
    failureLocation?(): string;
}) {
    return {
        metadata: () => Response.json(deps.metadata(), {
            headers: { "Cache-Control": "public, max-age=3600" },
        }),
        callback: async (request: Request) => {
            const session = await deps.session(request);
            const headers = {
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
            };
            if (!session)
                return new Response("Sign in and start MCP authentication again", {
                    status: 401,
                    headers,
                });
            const query = new URL(request.url).searchParams;
            try {
                const context = await deps.finish({ userId: session.user.id, sessionId: session.session.id }, query.get("state") ?? "", query.get("code") ?? undefined, query.get("iss") ?? undefined);
                return new Response(null, {
                    status: 302,
                    headers: { ...headers, Location: deps.successLocation(context) },
                });
            }
            catch (error) {
                // The provider's error is a registered OAuth code; state and code are never logged.
                const providerError = query.get("error");
                console.warn("MCP sign-in callback failed", failureReason(error), ...(providerError && /^[a-z_]{1,64}$/.test(providerError)
                    ? [`provider ${providerError}`]
                    : []));
                return new Response(null, {
                    status: 302,
                    headers: {
                        ...headers,
                        Location: deps.failureLocation?.() ?? "/app/connections?oauth=failed",
                    },
                });
            }
        },
    };
}
type McpAuthorization = {
    auth: {
        revokedAt: Date | null;
        expiresAt: Date | null;
    };
    device: {
        revokedAt: Date | null;
    };
};
/** Bearer and OAuth envelopes share expiry checks; app callbacks enforce live access. */
export function createMcpHttpHandler<A extends McpAuthorization>(deps: {
    origin: string;
    auth: Parameters<typeof requireMcpAuth>[0];
    resolveAuthorization(input: {
        token: string;
    } | {
        userId: string;
        referenceId: string;
    }): Promise<A | undefined>;
    resolveRuntime(authorization: A): Runtime | Promise<Runtime>;
    ingress?(authorization: A): Promise<void>;
    handle(request: Request, runtime: Runtime): Promise<Response>;
    mapError(error: unknown, mode: "token" | "oauth"): Response;
}) {
    const valid = (row: A | undefined): row is A => !!row &&
        !row.auth.revokedAt &&
        !row.device.revokedAt &&
        (!row.auth.expiresAt || row.auth.expiresAt > new Date());
    const dispatch = async (request: Request, row: A) => {
        const runtime = await deps.resolveRuntime(row);
        await deps.ingress?.(row);
        return deps.handle(request, runtime);
    };
    const oauth = requireMcpAuth(deps.auth, async (request, claims) => {
        if (typeof claims.sub !== "string" ||
            typeof claims.toolstile_authorization !== "string")
            return new Response("Agent authorization required", { status: 403 });
        try {
            const row = await deps.resolveAuthorization({
                userId: claims.sub,
                referenceId: claims.toolstile_authorization,
            });
            if (!valid(row))
                throw new Error("Agent access revoked or unavailable");
            return await dispatch(request, row);
        }
        catch (error) {
            return deps.mapError(error, "oauth");
        }
    }, { resource: `${deps.origin}/mcp`, requiredScopes: ["mcp:access"] });
    return async (request: Request) => {
        const origin = request.headers.get("origin");
        if (origin && origin !== deps.origin)
            return new Response("Invalid origin", { status: 403 });
        const token = request.headers
            .get("authorization")
            ?.replace(/^Bearer /i, "");
        if (!token?.startsWith("ts_"))
            return oauth(request);
        // Keep token lookup failures outside dispatch error mapping for compatibility.
        const row = await deps.resolveAuthorization({ token });
        if (!valid(row))
            return new Response("Agent token invalid or expired", { status: 401 });
        try {
            return await dispatch(request, row);
        }
        catch (error) {
            return deps.mapError(error, "token");
        }
    };
}
