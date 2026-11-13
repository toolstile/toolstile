import type { Client, McpSubscription } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/server";
import type { Runtime, Upstream } from "./index";
import {
	accessState,
	interactionOptions,
	recheckLive,
	upstreamIdentity,
} from "./sessions";

type Subscription = {
	aliases: Set<string>;
	client: Client;
	source: string;
	rules: string;
	upstreamId: string;
	uri: string;
	listener?: McpSubscription;
	closing?: Promise<void>;
};
export function resourceSubscriptions(
	runtime: Runtime,
	server: Server,
	helpers: {
		original(id: string, uri: string): string | undefined;
		permitted(upstream: Upstream, uri: string): boolean;
		open(upstream: Upstream, uri: string): Promise<Client>;
		touch(): void;
		lost(): void;
	},
) {
	const entries = new Map<string, Promise<Subscription>>();
	let closed = false;
	async function discard(key: string, entry: Subscription) {
		if (entry.closing) return entry.closing;
		entry.closing = (async () => {
			if ((await entries.get(key)) === entry) entries.delete(key);
			entry.client.onclose = undefined;
			entry.client.onerror = undefined;
			await entry.listener?.close();
			await entry.client.close();
		})();
		return entry.closing;
	}
	async function valid(entry: Subscription) {
		await recheckLive(
			runtime,
			{
				id: entry.upstreamId,
				identity: entry.source,
				rules: entry.rules,
				permitted: (current) => helpers.permitted(current, entry.uri),
			},
			{
				capability: "resources",
				target: entry.uri,
				method: "resources/subscription",
			},
			"Subscription access changed",
		);
	}
	return {
		async change(uri: string, subscribe: boolean) {
			if (closed) throw new Error("Session closed");
			const current = (await runtime.connections()).find(
				(upstream) => helpers.original(upstream.id, uri) !== undefined,
			);
			const original = current ? helpers.original(current.id, uri) : undefined;
			if (!current || !original || !helpers.permitted(current, original))
				throw new Error("Resource unavailable or access denied");
			await runtime.check?.(current.id, "resources", original);
			const key = JSON.stringify([current.id, original]);
			const existing = await entries.get(key);
			if (existing && upstreamIdentity(current) !== existing.source)
				await discard(key, existing);
			if (!subscribe) {
				const entry = await entries.get(key);
				if (entry) {
					entry.aliases.delete(uri);
					if (entry.aliases.size) return {};
					try {
						if (!entry.listener)
							await entry.client.unsubscribeResource(
								{ uri: original },
								interactionOptions(),
							);
					} finally {
						await discard(key, entry);
					}
				}
				return {};
			}
			if (!entries.has(key)) {
				if (entries.size >= 128)
					throw new Error("Session subscription capacity reached");
				const pending = (async () => {
					const client = await helpers.open(current, original);
					const entry: Subscription = {
						aliases: new Set([uri]),
						client,
						source: upstreamIdentity(current),
						rules: accessState(current),
						upstreamId: current.id,
						uri: original,
					};
					try {
						if (closed || !client.getServerCapabilities()?.resources?.subscribe)
							throw new Error(
								"Upstream resource subscriptions are unavailable",
							);
						client.setNotificationHandler(
							"notifications/resources/updated",
							async (notification) => {
								if (notification.params.uri !== original) return;
								try {
									await valid(entry);
									helpers.touch();
									for (const alias of entry.aliases)
										await server.sendResourceUpdated({
											uri: alias,
										});
								} catch {
									void discard(key, entry).catch(() => {});
								}
							},
						);
						client.setNotificationHandler(
							"notifications/resources/list_changed",
							async () => {
								try {
									await valid(entry);
									helpers.touch();
									await server.sendResourceListChanged();
								} catch {
									void discard(key, entry).catch(() => {});
								}
							},
						);
						if ((client.getNegotiatedProtocolVersion() ?? "") >= "2026-07-28") {
							entry.listener = await client.listen(
								{
									resourceSubscriptions: [original],
									...(client.getServerCapabilities()?.resources?.listChanged
										? { resourcesListChanged: true }
										: {}),
								},
								interactionOptions(),
							);
							if (
								!entry.listener.honoredFilter.resourceSubscriptions?.includes(
									original,
								)
							)
								throw new Error("Upstream declined the resource subscription");
							void entry.listener.closed
								.then(() => {
									if (!entry.closing && !closed) helpers.lost();
									return discard(key, entry);
								})
								.catch(() => {});
						} else
							await client.subscribeResource(
								{ uri: original },
								interactionOptions(),
							);
						client.onclose = () => {
							if (!closed && !entry.closing) helpers.lost();
							void discard(key, entry).catch(() => {});
						};
						client.onerror = client.onclose;
						await valid(entry);
						return entry;
					} catch (error) {
						await client.close();
						throw error;
					}
				})();
				entries.set(key, pending);
				try {
					await pending;
				} catch (error) {
					if (entries.get(key) === pending) entries.delete(key);
					throw error;
				}
			} else (await entries.get(key))?.aliases.add(uri);
			return {};
		},
		async close() {
			closed = true;
			const pending = [...entries.entries()];
			entries.clear();
			await Promise.allSettled(
				pending.map(async ([key, entry]) => discard(key, await entry)),
			);
		},
	};
}
