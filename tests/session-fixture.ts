import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import {
	Server,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { defined } from "./assertions";
export function fixture() {
	const requests: { method: string; accept: string | null }[] = [];
	const upstreams: {
		server: Server;
		transport: WebStandardStreamableHTTPServerTransport;
		subscribed: Set<string>;
	}[] = [];
	let aborted = 0;
	// A synthetic fetch has no native network operation retaining its Request.
	// Keep streaming request signals alive until cancellation, including under GC.
	const streamingRequests = new Set<Request>();
	const seen: string[] = [],
		callbacks: string[] = [];
	const request: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		requests.push({ method: req.method, accept: req.headers.get("accept") });
		const id = req.headers.get("mcp-session-id");
		if (req.method === "GET") {
			streamingRequests.add(req);
			req.signal.addEventListener("abort", () => {
				aborted++;
				streamingRequests.delete(req);
			});
		}
		let upstream = upstreams.find((item) => item.transport.sessionId === id);
		if (!id) {
			const server = new Server(
				{ name: "interactive-fixture", version: "1" },
				{
					capabilities: {
						tools: {},
						resources: { subscribe: true, listChanged: true },
					},
				},
			);
			const subscribed = new Set<string>();
			server.setRequestHandler("tools/list", async () => ({
				tools: [
					{ name: "interactive", inputSchema: { type: "object" } },
					{ name: "roots_only", inputSchema: { type: "object" } },
				],
			}));
			server.setRequestHandler("tools/call", async (request, context) => {
				const options = { relatedRequestId: context.mcpReq.id };
				const roots = await server.listRoots({}, options);
				seen.push(roots.roots[0]?.uri ?? "none");
				if (request.params.name === "roots_only")
					return { content: [{ type: "text", text: "roots returned" }] };
				const sample = await server.createMessage(
					{
						messages: [
							{ role: "user", content: { type: "text", text: "Summarize" } },
						],
						maxTokens: 20,
					},
					options,
				);
				const answer = await server.elicitInput(
					{
						message: "Continue?",
						requestedSchema: {
							type: "object",
							properties: { name: { type: "string" } },
						},
					},
					options,
				);
				await context.mcpReq.notify({
					method: "notifications/progress",
					params: {
						progressToken: request.params._meta?.progressToken ?? "fixture",
						progress: 1,
						total: 1,
					},
				});
				callbacks.push(answer.action);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ roots: roots.roots, sample, answer }),
						},
					],
				};
			});
			server.setRequestHandler("resources/list", async () => ({
				resources: [{ uri: "docs://one", name: "One" }],
			}));
			server.setRequestHandler("resources/subscribe", async (request) => {
				subscribed.add(request.params.uri);
				return {};
			});
			server.setRequestHandler("resources/unsubscribe", async (request) => {
				subscribed.delete(request.params.uri);
				return {};
			});
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: randomUUID,
			});
			await server.connect(transport);
			upstream = { server, transport, subscribed };
			upstreams.push(upstream);
		}
		if (!upstream) return new Response(null, { status: 404 });
		return upstream.transport.handleRequest(req);
	};
	return {
		request,
		requests,
		aborted: () => aborted,
		seen,
		callbacks,
		upstreams,
		async publish() {
			for (const entry of upstreams)
				if (entry.subscribed.has("docs://one"))
					await entry.server.sendResourceUpdated({ uri: "docs://one" });
		},
		async close() {
			await Promise.all(upstreams.map((entry) => entry.server.close()));
			streamingRequests.clear();
		},
	};
}
export async function startSessionFixture() {
	const f = fixture();
	const http = await serveFixture(f.request);
	return {
		...f,
		url: http.url,
		async close() {
			await f.close();
			await http.close();
		},
	};
}
export async function serveFixture(request: typeof fetch) {
	const server = createServer(async (incoming, outgoing) => {
		const abort = new AbortController();
		outgoing.once("close", () => abort.abort());
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
			const headers = new Headers();
			for (const [key, value] of Object.entries(incoming.headers))
				if (value)
					headers.set(key, Array.isArray(value) ? value.join(",") : value);
			const response = await request(
				new Request(`http://127.0.0.1${incoming.url}`, {
					method: incoming.method,
					headers,
					signal: abort.signal,
					...(incoming.method !== "GET" && incoming.method !== "HEAD"
						? { body: Buffer.concat(chunks) }
						: {}),
				}),
			);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.flushHeaders();
			if (response.body)
				Readable.from(
					(async function* () {
						const reader = defined(response.body).getReader();
						const cancel = () => {
							void reader.cancel().catch(() => {});
						};
						abort.signal.addEventListener("abort", cancel, { once: true });
						if (abort.signal.aborted) cancel();
						try {
							for (;;) {
								const { value, done } = await reader.read();
								if (done) return;
								yield Buffer.from(value);
							}
						} finally {
							abort.signal.removeEventListener("abort", cancel);
							await reader.cancel().catch(() => {});
							reader.releaseLock();
						}
					})(),
				)
					.on("error", () => outgoing.destroy())
					.pipe(outgoing);
			else outgoing.end();
		} catch {
			if (!outgoing.headersSent) outgoing.writeHead(500);
			outgoing.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Fixture did not start");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
