// A stdio MCP server for the local command tests. With `--fail`, it writes its token to
// standard error and exits before the handshake.
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

if (process.argv.includes("--fail")) {
	process.stderr.write(
		`fixture cannot start; token ${process.env.FIXTURE_TOKEN ?? "missing"}\n`,
	);
	process.exit(3);
}
const server = new Server(
	{ name: "toolstile-stdio-fixture", version: "1" },
	{ capabilities: { tools: {} } },
);
server.setRequestHandler("tools/list", async () => ({
	tools: ["echo", "environment", "hang", "create_issue"].map((name) => ({
		name,
		description: `Stdio fixture: ${name}`,
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
	})),
}));
server.setRequestHandler("tools/call", async (request) => {
	const { name } = request.params;
	if (name === "environment")
		return {
			content: [{ type: "text", text: JSON.stringify(process.env) }],
		};
	if (name === "hang") {
		// Records its process id, then never answers; the timer keeps it running after its
		// standard input closes, so only a signal stops it.
		writeFileSync(String(request.params.arguments?.text), String(process.pid));
		await new Promise((resolve) => setTimeout(resolve, 600_000));
	}
	return {
		content: [
			{
				type: "text",
				text: `${name} ${process.pid}: ${JSON.stringify(request.params.arguments ?? {})}`,
			},
		],
	};
});
await server.connect(new StdioServerTransport());
