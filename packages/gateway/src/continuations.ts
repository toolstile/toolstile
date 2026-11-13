import { randomBytes, randomUUID } from "node:crypto";
import {
	type CreateMessageResultWithTools,
	createRequestStateCodec,
	type InputRequest,
	type InputRequiredResult,
	type InputResponse,
	inputRequired,
	ProtocolError,
	specTypeSchemas,
} from "@modelcontextprotocol/server";
import { canonicalJson, sha256Hex } from "./approval";
import type { Runtime } from "./index";
import { clientCapabilities, type Origin, origins } from "./sessions";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function binding(
	request: { method: string; params?: unknown },
	origin: Origin,
) {
	const {
		_meta,
		requestState: _state,
		inputResponses: _responses,
		...params
	} = (request.params ?? {}) as Record<string, unknown>;
	// Bindings live only in this process's memory, so the key order may change freely.
	// Continued requests are not reviewed, so no approval size or depth limit applies.
	return sha256Hex(
		canonicalJson([request.method, params, clientCapabilities(origin)], {
			maxBytes: Number.POSITIVE_INFINITY,
			maxDepth: Number.POSITIVE_INFINITY,
		}),
	);
}
const unavailable = () =>
	new ProtocolError(-32602, "Invalid or expired requestState");
type InteractionResponse = InputResponse | CreateMessageResultWithTools;
function responseFor(
	request: InputRequest,
	value: unknown,
): InteractionResponse {
	const schema =
		request.method === "roots/list"
			? specTypeSchemas.ListRootsResult
			: request.method === "elicitation/create"
				? specTypeSchemas.ElicitResult
				: specTypeSchemas.CreateMessageResultWithTools;
	const parsed = schema["~standard"].validate(value);
	if (parsed.issues) throw new ProtocolError(-32602, "Invalid input response");
	return parsed.value;
}

/** A live upstream operation; answers resume it instead of replaying its work. */
export interface InteractionFlow {
	signal: AbortSignal;
	ask(request: InputRequest): Promise<InteractionResponse>;
	guard(check: () => Promise<void>): void;
}
type Pending = ReturnType<typeof deferred<InteractionResponse>> & {
	request: InputRequest;
};
type Flow = {
	id: string;
	key: string;
	binding: string;
	origin: Origin;
	expires: number;
	abort: AbortController;
	pending: Map<string, Pending>;
	guards: (() => Promise<void>)[];
	changed: ReturnType<typeof deferred<void>>;
	output?: { value: unknown } | { error: unknown };
	nonce?: string;
	busy: boolean;
	rounds: number;
	inputs: number;
};
export type ContinuationOptions = {
	/** An opaque owner reference; the signed codec still authenticates every ticket. */
	/** Disable periodic sweeps when the host owns a durable expiry alarm. */
	sweep?: boolean;
	routingId?: string;
	continuationMs?: number;
	maxContinuations?: number;
	maxContinuationsPerAgent?: number;
};

export function continuationHandler(options: ContinuationOptions = {}) {
	const ttl = options.continuationMs ?? 10 * 60_000;
	if (!Number.isFinite(ttl) || ttl <= 0)
		throw new RangeError("Continuation lifetime must be positive");
	// State contains only random references, never credentials or upstream payloads.
	// References intentionally die with this process, like the legacy sessions.
	const codec = createRequestStateCodec<{ id: string; nonce: string }>({
		key: randomBytes(32),
		ttlSeconds: Math.ceil(ttl / 1000),
	});
	const flows = new Map<string, Flow>();
	function pulse(flow: Flow) {
		flow.changed.resolve();
		flow.changed = deferred<void>();
	}
	function stop(flow: Flow, reason: unknown) {
		flows.delete(flow.id);
		flow.origin.active = false;
		flow.abort.abort(reason);
		for (const pending of flow.pending.values()) pending.reject(reason);
		flow.pending.clear();
		flow.output = { error: reason };
		pulse(flow);
	}
	const timer = options.sweep === false ? undefined : setInterval(
		() => {
			for (const flow of flows.values())
				if (Date.now() >= flow.expires) stop(flow, unavailable());
		},
		Math.min(ttl, 60_000),
	);
	timer?.unref();
	return {
		async run<T>(
			request: { method: string; params?: unknown },
			origin: Origin,
			runtime: Runtime,
			work: () => T | Promise<T>,
		): Promise<T | InputRequiredResult> {
			if (!runtime.sessionKey) throw unavailable();
			const echoed = origin.context.mcpReq.requestState<unknown>();
			const digest = binding(request, origin);
			let flow: Flow;
			if (echoed !== undefined) {
				let ticket: { id: string; nonce: string };
				try {
					if (typeof echoed !== "string" || echoed.length > 4096)
						throw unavailable();
					const prefix = options.routingId ? `${options.routingId}.` : "";
                    if (prefix && !echoed.startsWith(prefix)) throw unavailable();
                    ticket = await codec.verify(echoed.slice(prefix.length), origin.context);
				} catch {
					throw unavailable();
				}
				const found = flows.get(ticket?.id);
				if (
					!found ||
					found.busy ||
					found.key !== runtime.sessionKey ||
					found.binding !== digest ||
					found.nonce !== ticket.nonce ||
					Date.now() >= found.expires
				)
					throw unavailable();
				flow = found;
				// Consume before any asynchronous admission or answer processing.
				flow.nonce = undefined;
				flow.busy = true;
				flow.origin.context = origin.context;
			} else {
				if (origin.context.mcpReq.inputResponses) throw unavailable();
				if (
					flows.size >= (options.maxContinuations ?? 10_000) ||
					[...flows.values()].filter((f) => f.key === runtime.sessionKey)
						.length >= (options.maxContinuationsPerAgent ?? 32)
				)
					throw new ProtocolError(
						-32000,
						"Gateway continuation capacity reached",
					);
				flow = {
					id: randomUUID(),
					key: runtime.sessionKey,
					binding: digest,
					origin,
					expires: Date.now() + ttl,
					abort: new AbortController(),
					pending: new Map(),
					guards: [],
					changed: deferred<void>(),
					busy: true,
					rounds: 0,
					inputs: 0,
				};
				origin.flow = {
					signal: flow.abort.signal,
					guard: (check) => {
						flow.guards.push(check);
					},
					ask: (input) => {
						if (flow.abort.signal.aborted) return Promise.reject(unavailable());
						if (++flow.inputs > 64)
							return Promise.reject(new Error("Too many input requests"));
						const pending = {
							...deferred<InteractionResponse>(),
							request: input,
						};
						flow.pending.set(randomUUID(), pending);
						pulse(flow);
						return pending.promise;
					},
				};
				flows.set(flow.id, flow);
			}
			const legSignal = origin.context.mcpReq.signal;
			const abortLeg = () =>
				stop(flow, new Error("Originating request cancelled"));
			legSignal.addEventListener("abort", abortLeg, { once: true });
			try {
				if (legSignal.aborted) throw new Error("Originating request cancelled");
				await runtime.authenticate?.();
				flow.abort.signal.throwIfAborted();
				if (echoed !== undefined) {
					for (const check of flow.guards) await check();
					flow.abort.signal.throwIfAborted();
					const answers: [string, Pending, InteractionResponse][] = [];
					const responses = origin.context.mcpReq.inputResponses ?? {};
					for (const [key, pending] of flow.pending) {
						if (origin.context.mcpReq.droppedInputResponseKeys?.includes(key))
							throw new ProtocolError(-32602, "Invalid input response");
						if (Object.hasOwn(responses, key))
							answers.push([
								key,
								pending,
								responseFor(pending.request, responses[key]),
							]);
					}
					for (const [key, pending, value] of answers) {
						flow.pending.delete(key);
						pending.resolve(value);
					}
				} else {
					void origins.run(flow.origin, async () => {
						try {
							const value = await work();
							if (!flow.abort.signal.aborted) flow.output = { value };
						} catch (error) {
							if (!flow.abort.signal.aborted) flow.output = { error };
						} finally {
							pulse(flow);
						}
					});
				}
				// Let answered handlers advance before deciding whether another round is needed.
				await Promise.resolve();
				for (;;) {
					if (flow.output) {
						if ("error" in flow.output) throw flow.output.error;
						for (const check of flow.guards) await check();
						flow.abort.signal.throwIfAborted();
						flows.delete(flow.id);
						flow.origin.active = false;
						return flow.output.value as T;
					}
					if (flow.pending.size) {
						if (++flow.rounds > 64) throw new Error("Too many input rounds");
						flow.nonce = randomUUID();
						const state = await codec.mint({ id: flow.id, nonce: flow.nonce });
						flow.abort.signal.throwIfAborted();
						flow.busy = false;
						return inputRequired({
							inputRequests: Object.fromEntries(
								[...flow.pending].map(([key, value]) => [key, value.request]),
							),
							requestState: options.routingId ? `${options.routingId}.${state}` : state,
						});
					}
					await flow.changed.promise;
				}
			} catch (error) {
				stop(flow, error);
				throw error;
			} finally {
				legSignal.removeEventListener("abort", abortLeg);
			}
		},
		revoke(key: string) {
			for (const flow of flows.values())
				if (flow.key === key) stop(flow, unavailable());
		},
		close() {
			clearInterval(timer);
			for (const flow of flows.values()) stop(flow, unavailable());
		},
		get size() {
			return flows.size;
		},
	};
}
