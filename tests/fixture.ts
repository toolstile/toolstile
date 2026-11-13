import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
	Server,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
export async function startFixture(port = 0) {
	let calls = 0;
	const http = createServer(async (incoming, outgoing) => {
		if (incoming.method === "GET") {
			outgoing.writeHead(405, { Allow: "POST" });
			outgoing.end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const headers = new Headers();
		for (const [key, value] of Object.entries(incoming.headers))
			if (value)
				headers.set(key, Array.isArray(value) ? value.join(",") : value);
		const request = new Request(`http://127.0.0.1${incoming.url}`, {
			method: incoming.method,
			headers,
			...(incoming.method !== "GET" && incoming.method !== "HEAD"
				? { body: Buffer.concat(chunks) }
				: {}),
		});
		const server = new Server(
			{ name: "toolstile-local-fixture", version: "1" },
			{
				capabilities: {
					tools: {},
					resources: {},
					prompts: {},
					completions: {},
				},
			},
		);
		server.setRequestHandler("tools/list", async () => ({
			tools: ["read_docs", "write_note", "delete_note"].map((name) => ({
				name,
				description: `Local fixture: ${name}`,
				inputSchema: {
					type: "object",
					properties: { text: { type: "string" } },
				},
			})),
		}));
		server.setRequestHandler("tools/call", async (req) => {
			calls++;
			return {
				content: [
					{ type: "text", text: `${req.params.name}: local fixture success` },
				],
			};
		});
		server.setRequestHandler("resources/list", async () => ({
			resources: [{ uri: "test://readme", name: "Fixture readme" }],
		}));
		server.setRequestHandler("resources/read", async () => ({
			contents: [{ uri: "test://readme", text: "Local fixture document" }],
		}));
		server.setRequestHandler("prompts/list", async () => ({
			prompts: [{ name: "review", description: "A local fixture prompt" }],
		}));
		server.setRequestHandler("prompts/get", async () => ({
			messages: [
				{
					role: "user",
					content: { type: "text", text: "Review the local fixture document" },
				},
			],
		}));
		server.setRequestHandler("completion/complete", async () => ({
			completion: { values: ["fixture completion"] },
		}));
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		try {
			await server.connect(transport);
			const response = await transport.handleRequest(request);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			outgoing.writeHead(500);
			outgoing.end();
		} finally {
			await server.close();
		}
	});
	await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
	const address = http.address();
	if (!address || typeof address === "string")
		throw new Error("Fixture failed to listen");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		calls: () => calls,
		close: () =>
			new Promise<void>((resolve, reject) =>
				http.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const fixture = await startFixture(4312);
	console.log(`Local MCP fixture: ${fixture.url}`);
}
