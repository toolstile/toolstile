import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { EventStore, JSONRPCMessage } from "@modelcontextprotocol/server";
import { sha256Hex } from "./approval";
import type { Kind, Operation, Runtime } from "./index";
import { admitInFlight, upstreamIdentity } from "./sessions";

export type ReplayOptions = {
	replayMaxEvents?: number;
	replayMaxBytes?: number;
	replayTtlMs?: number;
};
type Guard = { connectionId: string; capability: Kind; target?: string };
type Scope = { guards: Map<string, Guard> };
type Stored = {
	id: string;
	stream: string;
	message: JSONRPCMessage;
	snapshot: string;
	scope?: Scope;
	expires: number;
	bytes: number;
};

/** Legacy session-local replay. It re-delivers retained messages, never re-runs operations. */
export function sessionReplay(
	initialRuntime: Runtime,
	options: ReplayOptions = {},
) {
	let liveRuntime = initialRuntime;
	const scope = new AsyncLocalStorage<Scope>();
	const events = new Map<string, Stored>();
	let bytes = 0;
	let closed = false;
	function forget(event: Stored) {
		events.delete(event.id);
		bytes -= event.bytes;
	}
	function prune() {
		for (const event of events.values())
			if (event.expires <= Date.now()) forget(event);
		while (
			events.size > (options.replayMaxEvents ?? 256) ||
			bytes > (options.replayMaxBytes ?? 1024 * 1024)
		) {
			const first = events.values().next().value;
			if (!first) break;
			forget(first);
		}
	}
	async function snapshot() {
		const sources = await liveRuntime.connections();
		return sha256Hex(
			JSON.stringify(
				sources
					.map((source) => [source.id, upstreamIdentity(source), source.rules])
					.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
			),
		);
	}
	function remember(connectionId: string, capability?: Kind, target?: string) {
		if (!capability) return;
		const guard = { connectionId, capability, target };
		scope.getStore()?.guards.set(JSON.stringify(guard), guard);
	}
	const runtime: Runtime = {
		...initialRuntime,
		...(initialRuntime.check
			? {
					async check(
						connectionId: string,
						kind?: Kind,
						target?: string,
						checkOptions?: { inFlight?: boolean; catalog?: boolean },
					) {
						await initialRuntime.check?.(
							connectionId,
							kind,
							target,
							checkOptions,
						);
						remember(connectionId, kind, target);
					},
				}
			: {}),
		async admit(operation: Operation) {
			await initialRuntime.admit(operation);
			const kind = operation.capability ?? operation.method.split("/")[0];
			if (["tools", "resources", "prompts"].includes(kind))
				remember(operation.connectionId, kind as Kind, operation.target);
		},
	};
	async function valid(event: Stored) {
		if (closed || event.expires <= Date.now())
			throw new Error("Replay unavailable; refetch");
		await liveRuntime.authenticate?.();
		if ((await snapshot()) !== event.snapshot)
			throw new Error("Replay access changed; refetch");
		// Replaying server-initiated questions could prompt the user twice. Require a
		// fresh request instead; ordinary results and change notifications are safe.
		if ("method" in event.message && "id" in event.message)
			throw new Error("Interactive streams cannot be replayed");
		const guards = event.scope?.guards;
		if (!guards?.size)
			throw new Error("Replay authorization unavailable; refetch");
		for (const guard of guards.values())
			await admitInFlight(liveRuntime, guard, `${guard.capability}/replay`);
		// A live check may itself have resolved a new account or rule revision.
		if ((await snapshot()) !== event.snapshot || closed)
			throw new Error("Replay access changed; refetch");
	}
	function retained(id: string) {
		prune();
		const anchor = events.get(id);
		if (!anchor)
			throw new Error("Replay cursor expired or unavailable; refetch");
		let after = false;
		const following: Stored[] = [];
		for (const event of events.values()) {
			if (after && event.stream === anchor.stream) following.push(event);
			if (event === anchor) after = true;
		}
		return { anchor, following };
	}
	const store: EventStore = {
		async storeEvent(stream, message) {
			const id = randomUUID();
			if (closed) return id;
			const serialized = JSON.stringify(message);
			const event: Stored = {
				id,
				stream,
				message: JSON.parse(serialized),
				scope: scope.getStore(),
				snapshot: await snapshot(),
				bytes: Buffer.byteLength(serialized),
				expires: Date.now() + (options.replayTtlMs ?? 5 * 60_000),
			};
			if (closed) return id;
			// Do not let an oversized message create an undetectable gap in a stream.
			if (event.bytes > (options.replayMaxBytes ?? 1024 * 1024)) {
				for (const stored of events.values())
					if (stored.stream === stream) forget(stored);
				return id;
			}
			events.set(id, event);
			bytes += event.bytes;
			prune();
			return id;
		},
		async getStreamIdForEventId(id) {
			prune();
			return events.get(id)?.stream;
		},
		async replayEventsAfter(id, { send }) {
			const { anchor, following } = retained(id);
			await valid(anchor);
			for (const event of following) {
				await valid(event);
				await send(event.id, event.message);
			}
			return anchor.stream;
		},
	};
	return {
		runtime,
		store,
		capture<T>(work: () => T): T {
			return scope.run({ guards: new Map() }, work);
		},
		async preflight(id: string, currentRuntime: Runtime) {
			liveRuntime = currentRuntime;
			const { anchor, following } = retained(id);
			await valid(anchor);
			for (const event of following) await valid(event);
		},
		close() {
			closed = true;
			events.clear();
			bytes = 0;
		},
	};
}
