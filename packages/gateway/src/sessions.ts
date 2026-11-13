import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Client, ClientCapabilities } from "@modelcontextprotocol/client";
import {
	CLIENT_CAPABILITIES_META_KEY,
	type CreateMessageResult,
	type CreateMessageResultWithTools,
	type ElicitResult,
	inputRequired,
	type ListRootsResult,
	PROTOCOL_VERSION_META_KEY,
	type Server,
	type ServerContext,
	specTypeSchemas,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { sha256Hex } from "./approval";
import type { InteractionFlow } from "./continuations";
import type { Kind, Runtime, Upstream } from "./index";
import { type ReplayOptions, sessionReplay } from "./replay";

export function transportResponse(response: Response) {
	const headers = new Headers(response.headers);
	// Let the HTTP adapter decide connection persistence; an SSE keep-alive header
	// must not override an incoming Connection: close or leak into HTTP/2.
	headers.delete("connection");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
export interface Origin {
	server: Server;
	context: ServerContext;
	active: boolean;
	flow?: InteractionFlow;
}
export const origins = new AsyncLocalStorage<Origin>();
export function modernOrigin(origin: Origin) {
	const version = (origin.context.mcpReq.envelope as Record<string, unknown>)?.[
		PROTOCOL_VERSION_META_KEY
	];
	return typeof version === "string" && version >= "2026-07-28";
}
export function clientCapabilities(origin?: Origin): ClientCapabilities {
	const raw = (origin?.context.mcpReq.envelope as Record<string, unknown>)?.[
		CLIENT_CAPABILITIES_META_KEY
	];
	const parsed = specTypeSchemas.ClientCapabilities["~standard"].validate(raw);
	const caps =
		origin && modernOrigin(origin)
			? parsed.issues
				? undefined
				: parsed.value
			: origin?.server.getClientCapabilities();
	return {
		...(caps?.roots ? { roots: {} } : {}),
		...(caps?.sampling ? { sampling: caps.sampling } : {}),
		...(caps?.elicitation ? { elicitation: caps.elicitation } : {}),
	};
}
export function interactionOptions() {
	const origin = origins.getStore();
	if (!origin) return {};
	return {
		signal: origin.flow?.signal ?? origin.context.mcpReq.signal,
		...(origin.flow
			? { timeout: 10 * 60_000, maxTotalTimeout: 10 * 60_000 }
			: {}),
		onprogress: (progress: {
			progress: number;
			total?: number;
			message?: string;
		}) => {
			const token = origin.context.mcpReq._meta?.progressToken;
			if (typeof token !== "string" && typeof token !== "number") return;
			if (origin.context.mcpReq.signal.aborted) return;
			void origin.context.mcpReq
				.notify({
					method: "notifications/progress",
					params: { ...progress, progressToken: token },
				})
				.catch(() => {});
		},
	};
}
export function wireInteractions(
	client: Client,
	runtime: Runtime,
	upstream: Upstream,
	kind?: Kind,
	target?: string,
) {
	const origin = origins.getStore();
	if (!origin) return;
	const caps = clientCapabilities(origin);
	const allowed = async () => {
		if (
			!origin.active ||
			(origin.flow?.signal ?? origin.context.mcpReq.signal).aborted
		)
			throw new Error("Originating request is no longer active");
		await recheckLive(
			runtime,
			{ id: upstream.id, identity: upstreamIdentity(upstream) },
			{
				capability: kind ?? "tools",
				target,
				method: `${kind ?? "tools"}/interaction`,
			},
			"Upstream account changed during the request",
			false,
		);
	};
	origin.flow?.guard(allowed);
	async function forward<T>(work: () => Promise<T>) {
		await allowed();
		const result = await work();
		await allowed();
		return result;
	}
	const options = {
		relatedRequestId: origin.context.mcpReq.id,
		signal: origin.context.mcpReq.signal,
	};
	if (caps.roots)
		client.setRequestHandler("roots/list", (req) =>
			forward(() =>
				origin.flow
					? (origin.flow.ask(
							inputRequired.listRoots(),
						) as Promise<ListRootsResult>)
					: origin.server.listRoots(req.params, options),
			),
		);
	if (caps.sampling)
		client.setRequestHandler("sampling/createMessage", (req) =>
			forward(() =>
				origin.flow
					? (origin.flow.ask(
							inputRequired.createMessage(req.params),
						) as Promise<CreateMessageResult | CreateMessageResultWithTools>)
					: origin.server.createMessage(req.params, options),
			),
		);
	if (caps.elicitation)
		client.setRequestHandler("elicitation/create", (req) =>
			forward(() =>
				origin.flow
					? (origin.flow.ask(
							req.params.mode === "url"
								? inputRequired.elicitUrl({
										...req.params,
										message: `[${upstream.label}] ${req.params.message}`,
									})
								: inputRequired.elicit({
										...req.params,
										message: `[${upstream.label}] ${req.params.message}`,
									}),
						) as Promise<ElicitResult>)
					: origin.server.elicitInput(
							{
								...req.params,
								message: `[${upstream.label}] ${req.params.message}`,
							},
							options,
						),
			),
		);
}
export type SessionHooks = {
	close(): Promise<void>;
	active: number;
	touch(): void;
};
export type SessionOptions = {
	/** Host-provided opaque owner ID for distributed session routing. */
	/** Disable periodic sweeps when the host owns a durable expiry alarm. */
	sweep?: boolean;
	sessionIdGenerator?: () => string;
	idleMs?: number;
	maxSessions?: number;
	maxSessionsPerAgent?: number;
	maxSessionsPerOwner?: number;
	sessionInitializationsPerMinute?: number;
};
type Entry = {
	release(): void;
	replay: ReturnType<typeof sessionReplay>;
	closing?: Promise<void>;
	key: string;
	runtime: Runtime;
	server: Server;
	transport: WebStandardStreamableHTTPServerTransport;
	used: number;
	active: number;
};
export function sessionHandler(
	build: (runtime: Runtime, hooks: SessionHooks) => Server,
	fallback: (request: Request, runtime: Runtime) => Promise<Response>,
	options: SessionOptions & ReplayOptions = {},
) {
	const sessions = new Map<string, Entry>();
	let reserved = 0;
	const perAgent = new Map<string, number>(),
		perOwner = new Map<string, number>();
	const buckets = new Map<string, { tokens: number; updated: number }>();
	const rate = options.sessionInitializationsPerMinute ?? 60;
	const ownerKey = (key: string) => key.slice(0, key.lastIndexOf(":"));
	function change(counts: Map<string, number>, key: string, delta: number) {
		const value = (counts.get(key) ?? 0) + delta;
		if (value) counts.set(key, value);
		else counts.delete(key);
	}
	function reserve(key: string) {
		const owner = ownerKey(key),
			now = Date.now();
		if (
			reserved >= (options.maxSessions ?? 10_000) ||
			(perAgent.get(key) ?? 0) >= (options.maxSessionsPerAgent ?? 32) ||
			(perOwner.get(owner) ?? 0) >= (options.maxSessionsPerOwner ?? 256)
		)
			return;
		const previous = buckets.get(key);
		const tokens = Math.min(
			rate,
			(previous?.tokens ?? rate) +
				((now - (previous?.updated ?? now)) * rate) / 60_000,
		);
		if (tokens < 1) return;
		buckets.set(key, { tokens: tokens - 1, updated: now });
		reserved++;
		change(perAgent, key, 1);
		change(perOwner, owner, 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			reserved--;
			change(perAgent, key, -1);
			change(perOwner, owner, -1);
		};
	}
	const idle = options.idleMs ?? 30 * 60_000;
	async function close(entry: Entry) {
		if (entry.closing) return entry.closing;
		for (const [id, value] of sessions)
			if (value === entry) sessions.delete(id);
		entry.release();
		entry.replay.close();
		entry.closing = entry.server.close();
		await entry.closing;
	}
	const timer = options.sweep === false ? undefined : setInterval(
		() => {
			for (const [key, bucket] of buckets)
				if (Date.now() - bucket.updated >= 60_000) buckets.delete(key);
			for (const entry of sessions.values())
				if (!entry.active && Date.now() - entry.used >= idle)
					void close(entry).catch(() => {});
		},
		Math.min(idle, 60_000),
	);
	timer?.unref();
	return {
		async handle(request: Request, runtime: Runtime) {
			await runtime.authenticate?.();
			const key = runtime.sessionKey;
			if (!key) return fallback(request, runtime);
			const id = request.headers.get("mcp-session-id");
			if (id) {
				const entry = sessions.get(id);
				if (!entry || entry.key !== key)
					return new Response("Session unavailable; initialize again", {
						status: 404,
					});
				entry.used = Date.now();
				const cursor =
					request.method === "GET" && request.headers.get("last-event-id");
				if (cursor) {
					try {
						await entry.replay.preflight(cursor, runtime);
					} catch {
						return Response.json(
							{
								jsonrpc: "2.0",
								error: {
									code: -32602,
									message:
										"Replay unavailable or access changed; reinitialize and refetch",
								},
								id: null,
							},
							{ status: 409 },
						);
					}
				}
				return transportResponse(
					await entry.replay.capture(() =>
						entry.transport.handleRequest(request),
					),
				);
			}
			if (request.method !== "POST")
				return new Response("Initialize a session first", {
					status: 405,
					headers: { Allow: "POST" },
				});
			const body = await request
				.clone()
				.json()
                .then((value): Record<string,unknown> => value && typeof value === "object" ? value as Record<string,unknown> : {})
                .catch((): Record<string,unknown> => ({}));
			if (body?.method !== "initialize") return fallback(request, runtime);
			const release = reserve(key);
			if (!release)
				return new Response("Gateway session capacity reached", {
					status: 503,
				});
			let entry: Entry | undefined;
			let initialized = false;
			try {
				const hooks: SessionHooks = {
					active: 0,
					touch() {
						if (entry) entry.used = Date.now();
					},
					async close() {
						if (entry) await close(entry);
					},
				};
				const replay = sessionReplay(runtime, options);
				const server = build(replay.runtime, hooks);
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: options.sessionIdGenerator ?? randomUUID,
					enableJsonResponse: false,
					eventStore: replay.store,
					onsessioninitialized: (id) => {
						initialized = true;
						if (entry) sessions.set(id, entry);
					},
					onsessionclosed: async () => {
						if (entry) await close(entry);
					},
				});
				entry = {
					release,
					key,
					runtime,
					server,
					transport,
					replay,
					used: Date.now(),
					get active() {
						return hooks.active;
					},
				};
				await server.connect(transport);
				const response = await replay.capture(() =>
					transport.handleRequest(request),
				);
				if (response.status >= 400) await close(entry);
				return transportResponse(response);
			} catch (error) {
				if (entry) await close(entry).catch(() => {});
				throw error;
			} finally {
				if (!initialized) release();
			}
		},
		async revoke(key: string) {
			await Promise.all(
				[...sessions.values()].filter((entry) => entry.key === key).map(close),
			);
		},
		async close() {
			clearInterval(timer);
			buckets.clear();
			await Promise.all([...sessions.values()].map(close));
		},
		get size() {
			return sessions.size;
		},
	};
}
type LiveExpectation = {
	id: string;
	identity: string;
	/** JSON of the rules captured when the work began; omitted when rule edits may continue. */
	rules?: string;
	permitted?(current: Upstream): boolean;
};
/** Re-authenticate and return the connection while it still matches the work in flight. */
export async function liveConnection(
	runtime: Runtime,
	expected: LiveExpectation,
	message: string,
) {
	await runtime.authenticate?.();
	const current = (await runtime.connections()).find(
		(source) => source.id === expected.id,
	);
	if (
		!current ||
		upstreamIdentity(current) !== expected.identity ||
		(expected.rules !== undefined && accessState(current) !== expected.rules) ||
		(expected.permitted && !expected.permitted(current))
	)
		throw new Error(message);
	return current;
}
/** Admit work continuing on an open upstream: a live in-flight check, or a maintenance admission. */
export async function admitInFlight(
	runtime: Runtime,
	guard: { connectionId: string; capability: Kind; target?: string },
	method: string,
) {
	if (runtime.check) {
		await runtime.check(guard.connectionId, guard.capability, guard.target, {
			inFlight: true,
		});
		return;
	}
	await runtime.admit({
		id: randomUUID(),
		connectionId: guard.connectionId,
		method,
		capability: guard.capability,
		target: guard.target,
		maintenance: true,
	});
}
/** Confirm the connection, admit continued work, then (unless `confirmAfter` is false)
 * confirm again: a live check may itself resolve a new account or rule revision. */
export async function recheckLive(
	runtime: Runtime,
	expected: LiveExpectation,
	work: { capability: Kind; target?: string; method: string },
	message: string,
	confirmAfter = true,
) {
	const current = await liveConnection(runtime, expected, message);
	await admitInFlight(
		runtime,
		{
			connectionId: current.id,
			capability: work.capability,
			target: work.target,
		},
		work.method,
	);
	if (confirmAfter) await liveConnection(runtime, expected, message);
}
/** Rules plus any tool review, compared to detect an access change on open work. */
export const accessState = (upstream: Upstream) =>
	JSON.stringify(
		upstream.toolReview
			? [upstream.rules, [...upstream.toolReview.reviewed].sort()]
			: upstream.rules,
	);
export const upstreamIdentity = (upstream: Upstream) =>
	sha256Hex(
		JSON.stringify([
			upstream.id,
			upstream.identityKey,
			upstream.url,
			upstream.transport,
			upstream.headers,
		]),
	);
