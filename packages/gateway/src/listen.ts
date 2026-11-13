import type { Client, McpSubscription } from "@modelcontextprotocol/client";
import {
	createMcpHandler,
	InMemoryServerEventBus,
	ProtocolError,
	type Server,
	type ServerCapabilities,
	type ServerEvent,
	type SubscriptionFilter,
	specTypeSchemas,
} from "@modelcontextprotocol/server";
import type { Kind, Runtime, Upstream } from "./index";
import { accessState, recheckLive, upstreamIdentity } from "./sessions";

export type ListenOptions = {
	maxSubscriptionStreams?: number;
	maxSubscriptionStreamsPerAgent?: number;
};
type Helpers = {
	original(id: string, uri: string): string | undefined;
	permitted(upstream: Upstream, kind: Kind, target?: string): boolean;
	open(
		runtime: Runtime,
		upstream: Upstream,
		kind: Kind,
		target: string | undefined,
		signal: AbortSignal,
	): Promise<Client>;
};
type Watch = {
	source: Upstream;
	identity: string;
	rules: string;
	kind: Kind;
	uri?: string;
	aliases?: string[];
};
type Entry = {
	key: string;
	close(error?: Error, graceful?: boolean): Promise<void>;
};

/** Request-local buses prevent notifications crossing authenticated agent streams. */
export function modernSubscriptions(
	helpers: Helpers,
	options: ListenOptions = {},
) {
	const entries = new Set<Entry>();
	let closed = false;
	return {
		async handle(
			request: Request,
			runtime: Runtime,
			build: (caps?: ServerCapabilities) => Server,
		) {
			// The SDK consumes the request before invoking its factory.
			const body = await request
				.clone()
				.json()
                .then((value): Record<string,unknown> => value && typeof value === "object" ? value as Record<string,unknown> : {})
                .catch((): Record<string,unknown> => ({}));
			const bus = new InMemoryServerEventBus();
			const clients = new Set<Client>();
			const subscriptions = new Set<McpSubscription>();
			const abort = new AbortController();
			let entry: Entry | undefined;
			let stopped = false;
			let closing: Promise<void> | undefined;
			let output: ReadableStreamDefaultController<Uint8Array> | undefined;
			let failure: Error | undefined;
			let queued = 0;
			let dispatch = Promise.resolve();
			let id: string | number | null = null;
			let setupError: unknown;
			const handler = createMcpHandler(
				async () => {
					try {
						if (body.method !== "subscriptions/listen") return build();
						id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
						const parsed =
							specTypeSchemas.SubscriptionsListenRequest["~standard"].validate(
								body,
							);
						if (parsed.issues)
							throw new ProtocolError(-32602, "Invalid subscription filter");
						if (!runtime.sessionKey)
							throw new ProtocolError(
								-32602,
								"Authenticated agent required for subscriptions",
							);
						if (closed || stopped || abort.signal.aborted)
							throw new ProtocolError(-32603, "Subscription unavailable");
						if (
							entries.size >= (options.maxSubscriptionStreams ?? 1024) ||
							[...entries].filter((value) => value.key === runtime.sessionKey)
								.length >= (options.maxSubscriptionStreamsPerAgent ?? 16)
						)
							throw new ProtocolError(-32603, "Subscription capacity reached");
						entry = { key: runtime.sessionKey, close: stop };
						entries.add(entry);
						const filter = parsed.value.params.notifications;
						if ((filter.resourceSubscriptions?.length ?? 0) > 128)
							throw new ProtocolError(
								-32602,
								"Subscription resource capacity reached",
							);
						const sources = await runtime.connections();
						const watches: Watch[] = [];
						for (const alias of new Set(filter.resourceSubscriptions ?? [])) {
							const source = sources.find(
								(value) => helpers.original(value.id, alias) !== undefined,
							);
							const uri = source && helpers.original(source.id, alias);
							if (
								!source ||
								!uri ||
								!helpers.permitted(source, "resources", uri)
							)
								throw new ProtocolError(
									-32602,
									"Resource unavailable or access denied",
								);
							const existing = watches.find(
								(watch) => watch.source.id === source.id && watch.uri === uri,
							);
							if (existing) existing.aliases?.push(alias);
							else
								watches.push({
									source,
									identity: upstreamIdentity(source),
									rules: accessState(source),
									kind: "resources",
									uri,
									aliases: [alias],
								});
						}
						const caps: ServerCapabilities = {
							tools: {},
							prompts: {},
							resources: {},
						};
						for (const source of sources) {
							// One catalog watch per capability keeps every live permission check scoped.
							for (const kind of ["tools", "prompts", "resources"] as const) {
								const flag = `${kind}ListChanged` as keyof SubscriptionFilter;
								if (filter[flag] && helpers.permitted(source, kind))
									watches.push({
										source,
										kind,
										identity: upstreamIdentity(source),
										rules: accessState(source),
									});
							}
						}
						if (watches.length > 128)
							throw new ProtocolError(
								-32602,
								"Subscription source capacity reached",
							);
						for (const watch of watches) {
							await valid(watch);
							const client = await helpers.open(
								runtime,
								watch.source,
								watch.kind,
								watch.uri,
								abort.signal,
							);
							clients.add(client);
							if (stopped) {
								await client.close();
								throw new Error("Subscription closed");
							}
							client.onclose = () => {
								if (!stopped)
									void stop(
										new Error(
											"Upstream subscription disconnected; re-listen and refetch",
										),
									);
							};
							client.onerror = () => {
								if (!stopped)
									void stop(
										new Error(
											"Upstream subscription stream failed; re-listen and refetch",
										),
									);
							};
							const capability = client.getServerCapabilities()?.[watch.kind];
							const supported = watch.uri
								? client.getServerCapabilities()?.resources?.subscribe
								: capability?.listChanged;
							if (!supported) {
								clients.delete(client);
								client.onclose = undefined;
								client.onerror = undefined;
								await client.close();
								if (watch.uri)
									throw new ProtocolError(
										-32602,
										"Upstream resource subscriptions are unavailable",
									);
								continue;
							}
							const method = watch.uri
								? "notifications/resources/updated"
								: (`notifications/${watch.kind}/list_changed` as const);
							client.setNotificationHandler(method, (notification) => {
								if (
									watch.uri &&
									(!notification.params ||
										!("uri" in notification.params) ||
										notification.params.uri !== watch.uri)
								)
									return;
								if (stopped) return;
								if (++queued > 128) {
									void stop(
										new Error("Subscription notification capacity reached"),
									);
									return;
								}
								dispatch = dispatch.then(async () => {
									try {
										if (stopped) return;
										await valid(watch);
										if (stopped) return;
										if (watch.aliases)
											for (const uri of watch.aliases)
												bus.publish({ kind: "resource_updated", uri });
										else
											bus.publish({
												kind: `${watch.kind}_list_changed`,
											} as ServerEvent);
									} catch {
										void stop(
											new Error(
												"Subscription access changed; re-listen and refetch",
											),
										);
									} finally {
										queued--;
									}
								});
							});
							if (
								(client.getNegotiatedProtocolVersion() ?? "") >= "2026-07-28"
							) {
								const requested: SubscriptionFilter = watch.uri
									? { resourceSubscriptions: [watch.uri] }
									: { [`${watch.kind}ListChanged`]: true };
								const subscription = await client.listen(requested, {
									signal: abort.signal,
								});
								subscriptions.add(subscription);
								if (
									watch.uri
										? !subscription.honoredFilter.resourceSubscriptions?.includes(
												watch.uri,
											)
										: !subscription.honoredFilter[`${watch.kind}ListChanged`]
								)
									throw new ProtocolError(
										-32602,
										"Upstream declined the subscription",
									);
								void subscription.closed.then(() => {
									if (!stopped)
										void stop(
											new Error(
												"Upstream subscription ended; re-listen and refetch",
											),
										);
								});
							} else if (watch.uri)
								await client.subscribeResource(
									{ uri: watch.uri },
									{ signal: abort.signal },
								);
							await valid(watch);
							if (watch.uri)
								caps.resources = { ...caps.resources, subscribe: true };
							else
								caps[watch.kind] = { ...caps[watch.kind], listChanged: true };
						}
						return build(caps);
					} catch (error) {
						setupError = error;
						throw error;
					}
				},
				{ legacy: "reject", responseMode: "auto", bus },
			);
			async function valid(watch: Watch) {
				await recheckLive(
					runtime,
					{
						id: watch.source.id,
						identity: watch.identity,
						rules: watch.rules,
						permitted: (current) =>
							helpers.permitted(current, watch.kind, watch.uri),
					},
					{
						capability: watch.kind,
						target: watch.uri,
						method: `${watch.kind}/subscription`,
					},
					"Subscription access changed",
				);
			}
			function stop(error?: Error, graceful = false): Promise<void> {
				if (closing) return closing;
				stopped = true;
				failure = error;
				if (entry) entries.delete(entry);
				request.signal.removeEventListener("abort", onAbort);
				if (error) output?.error(error);
				closing = (async () => {
					if (graceful) await handler.close();
					abort.abort();
					await Promise.allSettled(
						[...subscriptions].map((subscription) => subscription.close()),
					);
					await Promise.allSettled(
						[...clients].map((client) => client.close()),
					);
					if (!graceful) await handler.close();
				})();
				return closing;
			}
			const onAbort = () => {
				void stop();
			};
			request.signal.addEventListener("abort", onAbort, { once: true });
			if (request.signal.aborted) onAbort();
			try {
				// Framework request wrappers can be fetch-compatible without carrying
				// the native Request constructor brand. Copy their explicit fields.
				const init: RequestInit & { duplex: "half" } = {
					method: request.method,
					headers: request.headers,
					body: request.body,
					signal: abort.signal,
					duplex: "half",
				};
				const response = await handler.fetch(new Request(request.url, init));
				if (setupError) {
					await response.body?.cancel();
					throw setupError;
				}
				if (!entry) {
					request.signal.removeEventListener("abort", onAbort);
					return response;
				}
				if (
					!response.body ||
					!response.headers.get("content-type")?.includes("text/event-stream")
				) {
					await stop();
					return response;
				}
				const reader = response.body.getReader();
				const body = new ReadableStream<Uint8Array>(
					{
						async start(controller) {
							output = controller;
							try {
								if (failure) throw failure;
								for (;;) {
									const next = await reader.read();
									if (next.done) break;
									if ((controller.desiredSize ?? 0) <= 0)
										throw new Error(
											"Subscription consumer is too slow; re-listen and refetch",
										);
									controller.enqueue(next.value);
								}
								if (!failure) controller.close();
							} catch (error) {
								if (!failure) controller.error(error);
							} finally {
								reader.releaseLock();
								await stop();
							}
						},
						async cancel() {
							await stop();
						},
					},
					{ highWaterMark: 1024 * 1024, size: (chunk) => chunk.byteLength },
				);
				return new Response(body, {
					status: response.status,
					headers: response.headers,
				});
			} catch (error) {
				await stop();
				return Response.json({
					jsonrpc: "2.0",
					id,
					error: {
						code: error instanceof ProtocolError ? error.code : -32603,
						message:
							error instanceof ProtocolError
								? error.message
								: "Subscription unavailable",
					},
				});
			}
		},
		async revoke(key: string) {
			await Promise.all(
				[...entries]
					.filter((entry) => entry.key === key)
					.map((entry) =>
						entry.close(new Error("Subscription authorization revoked")),
					),
			);
		},
		async close() {
			closed = true;
			await Promise.all(
				[...entries].map((entry) => entry.close(undefined, true)),
			);
		},
		get size() {
			return entries.size;
		},
	};
}
