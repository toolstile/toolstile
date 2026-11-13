import { randomBytes } from "node:crypto";
import {
	createMcpHandler,
	createRequestStateCodec,
	inputRequired,
	Server,
	type ServerContext,
} from "@modelcontextprotocol/server";

export function modernFixture() {
	const calls: { method: string; id: string | number | undefined }[] = [];
	const seen: unknown[] = [];
	let starts = 0;
	const codec = createRequestStateCodec<{ step: string; roots?: unknown }>({
		key: randomBytes(32),
	});
	const handler = createMcpHandler(
		() => {
			const server = new Server(
				{ name: "modern-only", version: "1" },
				{
					capabilities: { tools: {}, prompts: {}, resources: {} },
					requestState: { verify: codec.verify },
				},
			);
			async function interact(context: ServerContext) {
				const state = context.mcpReq.requestState<{
					step: string;
					roots?: unknown;
				}>();
				if (!state) {
					starts++;
					return inputRequired({
						inputRequests: { roots: inputRequired.listRoots() },
						requestState: await codec.mint({ step: "roots" }),
					});
				}
				if (state.step === "roots") {
					const roots = context.mcpReq.inputResponses?.roots;
					seen.push(roots);
					return inputRequired({
						inputRequests: {
							sample: inputRequired.createMessage({
								messages: [
									{
										role: "user",
										content: { type: "text", text: "Summarize" },
									},
								],
								maxTokens: 20,
							}),
							confirmation: inputRequired.elicit({
								message: "Continue?",
								requestedSchema: {
									type: "object",
									properties: { confirm: { type: "boolean" } },
								},
							}),
						},
						requestState: await codec.mint({ step: "details", roots }),
					});
				}
				const progressToken = context.mcpReq._meta?.progressToken;
				if (
					typeof progressToken === "number" ||
					typeof progressToken === "string"
				)
					await context.mcpReq.notify({
						method: "notifications/progress",
						params: { progressToken, progress: 1, total: 1 },
					});
				return { roots: state.roots, ...context.mcpReq.inputResponses };
			}
			server.setRequestHandler("tools/list", async () => ({
				tools: [{ name: "interactive", inputSchema: { type: "object" } }],
			}));
			server.setRequestHandler("prompts/list", async () => ({
				prompts: [{ name: "interactive" }],
			}));
			server.setRequestHandler("resources/list", async () => ({
				resources: [{ uri: "docs://one", name: "One" }],
			}));
			server.setRequestHandler("tools/call", async (_req, context) => {
				const result = await interact(context);
				return "resultType" in result
					? result
					: { content: [{ type: "text", text: JSON.stringify(result) }] };
			});
			server.setRequestHandler("prompts/get", async (_req, context) => {
				const result = await interact(context);
				return "resultType" in result
					? result
					: {
							messages: [
								{
									role: "user",
									content: { type: "text", text: JSON.stringify(result) },
								},
							],
						};
			});
			server.setRequestHandler("resources/read", async (_req, context) => {
				const result = await interact(context);
				return "resultType" in result
					? result
					: { contents: [{ uri: "docs://one", text: JSON.stringify(result) }] };
			});
			return server;
		},
		{ legacy: "reject", responseMode: "auto" },
	);
	const request: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		const body = await req
			.clone()
			.json()
			.catch(() => ({}));
		calls.push({ method: body.method, id: body.id });
		return handler.fetch(req);
	};
	return { request, calls, seen, starts: () => starts };
}
