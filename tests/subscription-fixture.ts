import { randomUUID } from "node:crypto";
import {
	createMcpHandler,
	InMemoryServerEventBus,
	type JSONRPCMessage,
	Server,
	type ServerEvent,
	type Transport,
} from "@modelcontextprotocol/server";
import { serveFixture } from "./session-fixture";

/** A modern notification source and a representative 2024 HTTP+SSE source. */
export async function subscriptionFixture(legacySse = false) {
	const bus = new InMemoryServerEventBus();
	const calls: { method: string; params?: Record<string, unknown> }[] = [];
	const sources = new Map<
		string,
		{
			server: Server;
			transport: Transport;
			subscribed: Set<string>;
			end(): void;
		}
	>();
	let disconnects = 0;
	function server(subscribed?: Set<string>) {
		const instance = new Server(
			{ name: "notifications-fixture", version: "1" },
			{
				capabilities: {
					tools: { listChanged: true },
					prompts: { listChanged: true },
					resources: { listChanged: true, subscribe: true },
				},
			},
		);
		instance.setRequestHandler("tools/list", async () => ({
			tools: [{ name: "echo", inputSchema: { type: "object" } }],
		}));
		instance.setRequestHandler("tools/call", async (req, context) => ({
			content: [
				{
					type: "text",
					text: req.params.arguments?.ask
						? JSON.stringify(
								await instance.listRoots(
									{},
									{ relatedRequestId: context.mcpReq.id },
								),
							)
						: String(req.params.arguments?.text ?? "echo"),
				},
			],
		}));
		instance.setRequestHandler("resources/list", async () => ({
			resources: [{ uri: "docs://one", name: "One" }],
		}));
		instance.setRequestHandler("resources/read", async () => ({
			contents: [{ uri: "docs://one", text: "one" }],
		}));
		instance.setRequestHandler("prompts/list", async () => ({
			prompts: [{ name: "review" }],
		}));
		instance.setRequestHandler("resources/subscribe", async (req) => {
			subscribed?.add(req.params.uri);
			return {};
		});
		instance.setRequestHandler("resources/unsubscribe", async (req) => {
			subscribed?.delete(req.params.uri);
			return {};
		});
		return instance;
	}
	const createHandler = () =>
		createMcpHandler(() => server(), { bus, legacy: "reject", keepAliveMs: 0 });
	let handler = createHandler();
	const request: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		if (!legacySse) {
			const body = await req
				.clone()
				.json()
				.catch(() => ({}));
			calls.push({ method: body.method, params: body.params });
			return handler.fetch(req);
		}
		if (req.method === "GET") {
			const id = randomUUID();
			const subscribed = new Set<string>();
			const instance = server(subscribed);
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			let ended = false;
			const encoder = new TextEncoder();
			function end() {
				if (ended) return;
				ended = true;
				disconnects++;
				sources.delete(id);
				try {
					controller.close();
				} catch {}
				req.signal.removeEventListener("abort", onAbort);
			}
			const transport: Transport = {
				async start() {},
				async send(message: JSONRPCMessage) {
					if (!ended)
						controller.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify(message)}\n\n`,
							),
						);
				},
				async close() {
					end();
					transport.onclose?.();
				},
			};
			const onAbort = () => {
				void instance.close();
			};
			const stream = new ReadableStream<Uint8Array>({
				start(value) {
					controller = value;
					controller.enqueue(
						encoder.encode(
							`event: endpoint\ndata: /messages?sessionId=${id}\n\n`,
						),
					);
				},
				cancel() {
					void instance.close();
				},
			});
			await instance.connect(transport);
			sources.set(id, { server: instance, transport, subscribed, end });
			req.signal.addEventListener("abort", onAbort, { once: true });
			if (req.signal.aborted) onAbort();
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream" },
			});
		}
		const source = sources.get(
			new URL(req.url).searchParams.get("sessionId") ?? "",
		);
		if (!source) return new Response(null, { status: 404 });
		const message = await req.json();
		calls.push({ method: message.method, params: message.params });
		source.transport.onmessage?.(message);
		return new Response(null, { status: 202 });
	};
	const http = await serveFixture(request);
	return {
		url: http.url,
		calls,
		bus,
		sources,
		disconnects: () => disconnects,
		async publish(event: ServerEvent) {
			if (!legacySse) {
				bus.publish(event);
				return;
			}
			for (const source of sources.values()) {
				if (event.kind === "resource_updated") {
					if (source.subscribed.has(event.uri))
						await source.server.sendResourceUpdated({ uri: event.uri });
				} else if (event.kind === "tools_list_changed")
					await source.server.sendToolListChanged();
				else if (event.kind === "prompts_list_changed")
					await source.server.sendPromptListChanged();
				else await source.server.sendResourceListChanged();
			}
		},
		async disconnect() {
			await handler.close();
			handler = createHandler();
			await Promise.all(
				[...sources.values()].map((source) => source.server.close()),
			);
		},
		async close() {
			await handler.close();
			await Promise.all(
				[...sources.values()].map((source) => source.server.close()),
			);
			await http.close();
		},
	};
}
