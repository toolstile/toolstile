import type { SetupClient } from "./setup-contract";

/** Where an agent app runs, which decides how it connects. */
export type AgentAppGroup = "computer" | "chat" | "automation";

/** One instruction; `code` is a command, file or URL shown with its own copy button. */
export type AgentStep = {
	text: string;
	code?: string;
	/** What `code` is, for the copy button's accessible name, such as "terminal command". */
	codeKind?: string;
};

export type AgentApp = {
	id: SetupClient;
	label: string;
	group: AgentAppGroup;
	/** "browser" apps sign in themselves; "token" apps need an agent token. */
	signIn: "browser" | "token";
	/** A plan or role the app requires, such as "Plus, Pro, Business or Enterprise plan". */
	requires?: string;
	steps: AgentStep[];
	/** A link that opens the app with the server filled in. */
	install?: { label: string; href: string };
	source: string;
	sourceLabel: string;
	/** Section id in the public client guide. */
	anchor?: string;
	/** How to approve the sign-in for an app on a machine reached over SSH. */
	remote?: string;
};

/** Apps that wait for sign-in on their own machine's loopback address can still be approved elsewhere. */
const overSsh =
	"On a machine you reach over SSH, add &device_name= and that machine's name (for example from hostname -s) to the end of the sign-in link it prints, then open the link here. After you approve, run the command shown on that machine.";

export const agentAppGroups: { id: AgentAppGroup; label: string }[] = [
	{ id: "computer", label: "On a computer" },
	{ id: "chat", label: "In a chat app" },
	{ id: "automation", label: "In an automation" },
];

/** The apps the picker shows first, most used first; the rest stay one step away. */
export const popularAgentApps: readonly SetupClient[] = [
	"claude-code",
	"codex",
	"cursor",
	"vscode",
	"claude",
	"chatgpt",
];

const urlStep = (text: string, endpoint: string): AgentStep => ({
	text,
	code: endpoint,
	codeKind: "server URL",
});

function base64(value: string) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Every app in the order the picker shows them, with steps for `endpoint`. */
export function agentApps(endpoint: string): AgentApp[] {
	const json = (value: unknown) => JSON.stringify(value, null, 2);
	return [
		{
			id: "claude-code",
			label: "Claude Code",
			group: "computer",
			signIn: "browser",
			steps: [
				{
					text: "Run this in a terminal.",
					code: `claude mcp add --transport http toolstile '${endpoint}'`,
					codeKind: "terminal command",
				},
				{
					text: "Start Claude Code, type /mcp, choose toolstile and sign in through your browser.",
				},
			],
			source: "https://code.claude.com/docs/en/mcp",
			sourceLabel: "Claude Code MCP reference",
			anchor: "claude-code",
			remote: overSsh,
		},
		{
			id: "codex",
			label: "Codex",
			group: "computer",
			signIn: "browser",
			steps: [
				{
					text: "Run these in a terminal. The second command opens your browser so you can sign in.",
					code: `codex mcp add toolstile --url '${endpoint}'\ncodex mcp login toolstile`,
					codeKind: "terminal commands",
				},
			],
			source: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
			sourceLabel: "Codex MCP reference",
			anchor: "codex",
			remote: overSsh,
		},
		{
			id: "cursor",
			label: "Cursor",
			group: "computer",
			signIn: "browser",
			install: {
				label: "Add to Cursor",
				href: `cursor://anysphere.cursor-deeplink/mcp/install?name=toolstile&config=${encodeURIComponent(base64(JSON.stringify({ url: endpoint })))}`,
			},
			steps: [
				{
					text: "Select Add to Cursor, or paste this into .cursor/mcp.json in your project.",
					code: json({ mcpServers: { toolstile: { url: endpoint } } }),
					codeKind: "file contents for .cursor/mcp.json",
				},
				{
					text: "In Cursor, open Customize → MCPs and select the sign-in prompt next to toolstile.",
				},
			],
			source: "https://cursor.com/docs/mcp",
			sourceLabel: "Cursor MCP reference",
			anchor: "cursor",
		},
		{
			id: "vscode",
			label: "VS Code",
			group: "computer",
			signIn: "browser",
			install: {
				label: "Add to VS Code",
				href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "toolstile", type: "http", url: endpoint }))}`,
			},
			steps: [
				{
					text: "Select Add to VS Code, or run this in a terminal.",
					code: `code --add-mcp '${JSON.stringify({ name: "toolstile", type: "http", url: endpoint })}'`,
					codeKind: "terminal command",
				},
				{
					text: "Open Chat in agent mode. VS Code asks you to sign in to toolstile when it first starts the server.",
				},
			],
			source:
				"https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
			sourceLabel: "VS Code MCP reference",
			anchor: "vscode",
		},
		{
			id: "gemini-cli",
			label: "Gemini CLI",
			group: "computer",
			signIn: "browser",
			steps: [
				{
					text: "Run this in a terminal.",
					code: `gemini mcp add --transport http toolstile '${endpoint}'`,
					codeKind: "terminal command",
				},
				{
					text: "Start Gemini CLI and run /mcp auth toolstile to sign in through your browser.",
				},
			],
			source: "https://geminicli.com/docs/tools/mcp-server/",
			sourceLabel: "Gemini CLI MCP reference",
			anchor: "gemini-cli",
		},
		{
			id: "cline",
			label: "Cline",
			group: "computer",
			signIn: "browser",
			steps: [
				{ text: "In Cline, open MCP Servers, then the Remote Servers tab." },
				urlStep(
					"Enter toolstile as the server name, paste this URL, choose Streamable HTTP and select Add Server.",
					endpoint,
				),
				{ text: "Sign in through your browser when Cline asks." },
			],
			source: "https://docs.cline.bot/mcp/connecting-to-a-remote-server",
			sourceLabel: "Cline remote server guide",
			anchor: "cline",
		},
		{
			id: "windsurf",
			label: "Windsurf",
			group: "computer",
			signIn: "browser",
			steps: [
				{
					text: "Windsurf is now Devin Desktop. Add this to ~/.config/devin/mcp_config.json (%APPDATA%\\devin\\mcp_config.json on Windows), or to .devin/mcp_config.json in a project.",
					code: json({
						mcpServers: { toolstile: { url: endpoint, transport: "http" } },
					}),
					codeKind: "file contents for mcp_config.json",
				},
				{
					text: "In the Agents window, open Customize → MCPs, refresh the list under This computer and sign in when toolstile asks.",
				},
			],
			source:
				"https://docs.devin.ai/desktop/devin-local/customizations#mcp-servers",
			sourceLabel: "Devin Desktop MCP reference",
			anchor: "windsurf",
		},
		{
			id: "goose",
			label: "Goose",
			group: "computer",
			signIn: "browser",
			install: {
				label: "Add to Goose",
				href: `goose://extension?${new URLSearchParams({ url: endpoint, type: "streamable_http", id: "toolstile", name: "toolstile", description: "MCP connections through Toolstile" })}`,
			},
			steps: [
				{
					text: "Select Add to Goose, or run this in a terminal and choose Add Extension, then Remote Extension (Streamable HTTP).",
					code: "goose configure",
					codeKind: "terminal command",
				},
				urlStep(
					"Enter toolstile as the name and paste this URL. Answer No to custom headers; Goose opens your browser to sign in.",
					endpoint,
				),
			],
			source: "https://goose-docs.ai/docs/getting-started/using-extensions",
			sourceLabel: "Goose extensions guide",
			anchor: "goose",
		},
		{
			id: "claude",
			label: "Claude",
			group: "chat",
			signIn: "browser",
			steps: [
				{
					text: "In Claude on the web, open Customize → Connectors, select + Add, then Add custom connector.",
				},
				urlStep(
					"Enter Toolstile as the name, paste this URL and select Continue.",
					endpoint,
				),
				{ text: "Choose Sign in now, select Add and sign in." },
			],
			source:
				"https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
			sourceLabel: "Claude connector help",
			anchor: "claude-desktop",
		},
		{
			id: "claude-desktop",
			label: "Claude Desktop",
			group: "chat",
			signIn: "browser",
			steps: [
				{
					text: "In Claude Desktop, open Customize → Connectors, select + Add, then Add custom connector.",
				},
				urlStep(
					"Enter Toolstile as the name, paste this URL and select Continue. The URL must be reachable from the internet.",
					endpoint,
				),
				{ text: "Choose Sign in now, select Add and sign in." },
			],
			source:
				"https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
			sourceLabel: "Claude connector help",
			anchor: "claude-desktop",
		},
		{
			id: "chatgpt",
			label: "ChatGPT",
			group: "chat",
			signIn: "browser",
			requires: "a paid ChatGPT plan",
			steps: [
				{
					text: "In ChatGPT, open Plugins, select +, then Add custom MCP server.",
				},
				urlStep(
					"Enter Toolstile as the name, paste this URL as the Server URL and choose OAuth.",
					endpoint,
				),
				{
					text: "Confirm the warning, select Create as a plugin, then install it and sign in.",
				},
			],
			source: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
			sourceLabel: "ChatGPT custom MCP guide",
			anchor: "chatgpt",
		},
		{
			id: "copilot",
			label: "Copilot Studio",
			group: "chat",
			signIn: "browser",
			steps: [
				{
					text: "In Copilot Studio, open your agent, then Tools → Add a tool → New tool → Model Context Protocol.",
				},
				urlStep(
					"Enter Toolstile as the server name, paste this URL and choose OAuth 2.0 with Dynamic discovery.",
					endpoint,
				),
				{
					text: "Select Create, then Create a new connection, sign in and select Add to agent.",
				},
			],
			source:
				"https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent",
			sourceLabel: "Copilot Studio MCP guide",
			anchor: "copilot",
		},
		{
			id: "le-chat",
			label: "Mistral",
			group: "chat",
			signIn: "browser",
			requires: "an admin of your Mistral organization",
			steps: [
				{
					text: "In Le Chat, open Connectors, select + Add Connector, then the Custom MCP Connector tab.",
				},
				urlStep(
					"Enter Toolstile as the name, paste this URL as the Server URL, then select Connect and sign in.",
					endpoint,
				),
			],
			source:
				"https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors",
			sourceLabel: "Mistral MCP connector guide",
			anchor: "le-chat",
		},
		{
			id: "perplexity",
			label: "Perplexity",
			group: "chat",
			signIn: "browser",
			requires: "a Pro, Max or Enterprise plan",
			steps: [
				{
					text: "In Perplexity, open Customize → Connectors, select Add custom, then Add MCP connector and choose Remote.",
				},
				urlStep(
					"Enter Toolstile as the name, paste this URL, accept the notice and select Add.",
					endpoint,
				),
				{ text: "Select the Toolstile card and sign in." },
			],
			source:
				"https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors",
			sourceLabel: "Perplexity custom connector help",
			anchor: "perplexity",
		},
		{
			id: "notion",
			label: "Notion",
			group: "chat",
			signIn: "browser",
			requires:
				"a Business or Enterprise plan with custom MCP servers turned on",
			steps: [
				{
					text: "In Notion, open Settings → Connections → Discover and select Add Custom MCP.",
				},
				urlStep("Paste this URL, select Connect and sign in.", endpoint),
			],
			source:
				"https://www.notion.com/help/connect-mcp-servers-to-your-notion-agent",
			sourceLabel: "Notion MCP connection help",
			anchor: "notion",
		},
		{
			id: "slackbot",
			label: "Slackbot",
			group: "chat",
			signIn: "browser",
			requires: "a Slack app installed in your workspace",
			steps: [
				{
					text: "At api.slack.com/apps, open your app's manifest and add this MCP server and the mcp:connect bot scope.",
					code: json({
						mcp_servers: {
							toolstile: {
								url: endpoint,
								auth_type: "dynamic_client_registration",
							},
						},
					}),
					codeKind: "manifest entry",
				},
				{ text: "Install the app to your workspace." },
				{
					text: "In a Slackbot direct message, open Apps, select + and add the app, then sign in.",
				},
			],
			source: "https://docs.slack.dev/ai/slackbot-mcp-client/",
			sourceLabel: "Slackbot MCP guide",
			anchor: "slackbot",
		},
		{
			id: "mcpjam",
			label: "MCPJam",
			group: "chat",
			signIn: "browser",
			steps: [
				urlStep(
					"In MCPJam, open Servers, add a server with HTTP as the transport and paste this URL.",
					endpoint,
				),
				{ text: "Choose OAuth as the authentication, connect and sign in." },
			],
			source: "https://docs.mcpjam.com/inspector/connecting-servers",
			sourceLabel: "MCPJam connection guide",
			anchor: "mcpjam",
		},
		{
			id: "n8n",
			label: "n8n",
			group: "automation",
			signIn: "token",
			steps: [
				{ text: "Add an MCP Client Tool node to your AI Agent node." },
				urlStep(
					"Set the endpoint to this URL and choose HTTP Streamable as the transport.",
					endpoint,
				),
				{
					text: "Set Authentication to Bearer Auth and create a credential with your agent token.",
				},
			],
			source:
				"https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/",
			sourceLabel: "n8n MCP Client Tool reference",
			anchor: "n8n",
		},
		{
			id: "agentcore",
			label: "AgentCore",
			group: "automation",
			signIn: "token",
			steps: [
				urlStep(
					"Create an MCP server target on your AgentCore gateway with this endpoint.",
					endpoint,
				),
				{
					text: "For outbound authentication, use an API key credential that sends your agent token in this header.",
					code: "Authorization: Bearer <agent token>",
					codeKind: "header",
				},
			],
			source:
				"https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html",
			sourceLabel: "AgentCore MCP server targets",
			anchor: "agentcore",
		},
	];
}

/** The app with this id, with steps for `endpoint`. */
export function agentApp(client: SetupClient, endpoint: string) {
	const app = agentApps(endpoint).find((candidate) => candidate.id === client);
	if (!app) throw new Error(`Unknown agent app ${client}`);
	return app;
}

export const agentClientLabels = Object.fromEntries(
	agentApps("").map(({ id, label }) => [id, label]),
) as Record<SetupClient, string>;

/** Name patterns each app registers, most specific first; plain "Claude" is the desktop app. */
const detectors: [RegExp, SetupClient][] = [
	[/\bclaude ?code\b/, "claude-code"],
	[/\bcodex\b/, "codex"],
	[/\bcursor\b/, "cursor"],
	[/\b(vs ?code|visual studio code|github copilot)\b/, "vscode"],
	[/\bgemini\b/, "gemini-cli"],
	[/\bcline\b/, "cline"],
	[/\b(windsurf|devin)\b/, "windsurf"],
	[/\bgoose\b/, "goose"],
	[/\b(chatgpt|openai)\b/, "chatgpt"],
	[/\bcopilot\b/, "copilot"],
	[/\b(le ?chat|mistral)\b/, "le-chat"],
	[/\bperplexity\b/, "perplexity"],
	[/\bnotion\b/, "notion"],
	[/\bslack(bot)?\b/, "slackbot"],
	[/\bmcp ?jam\b/, "mcpjam"],
	[/\bn8n\b/, "n8n"],
	[/\b(agent ?core|bedrock)\b/, "agentcore"],
	[/\bclaude\b/, "claude-desktop"],
];

/**
 * The agent app behind an agent, from its name. New agents are named after the client name
 * their app registers (such as "Codex" or "Claude Code"), with " (2)" added for repeats; a name
 * the user changes may no longer match, and then no app is shown.
 */
export function detectAgentClient(label: string): SetupClient | undefined {
	const name = label
		.toLowerCase()
		.replace(/\s*\(\d+\)\s*$/, "")
		.replace(/[-_.]+/g, " ")
		.trim();
	return detectors.find(([pattern]) => pattern.test(name))?.[1];
}
