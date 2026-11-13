/** Persisted setup selections contain identifiers and preferences, never credentials. */
export const setupSteps = ["connect", "agent", "access", "verify"] as const;
/** Agent apps with connect steps; persisted as text, so new ids need no migration. */
export const setupClients = [
	"claude-code",
	"codex",
	"cursor",
	"vscode",
	"gemini-cli",
	"cline",
	"windsurf",
	"goose",
	"claude",
	"claude-desktop",
	"chatgpt",
	"copilot",
	"le-chat",
	"perplexity",
	"notion",
	"slackbot",
	"mcpjam",
	"n8n",
	"agentcore",
] as const;
export type SetupStep = (typeof setupSteps)[number];
export type SetupClient = (typeof setupClients)[number];
export type SetupSelection = {
	connectionId?: string;
	agentId?: string;
	client: SetupClient;
};
export type SetupState = SetupSelection & {
	status: "active" | "skipped" | "finished";
	step: SetupStep;
	completed: {
		connect: boolean;
		agent: boolean;
		access: boolean;
		verify: boolean;
	};
	verifiedAt: string | null;
};
export type SetupApi = {
	setupStatus(): Promise<SetupState>;
	/** The agents setup can select; cheaper than `setupStatus` for polling. */
	setupAgents(): Promise<{ agentIds: string[] }>;
	saveSetup(
		input: SetupSelection & {
			step: SetupStep;
			action: "save" | "skip" | "resume" | "finish";
		},
	): Promise<SetupState>;
	verifySetup(input: {
		connectionId: string;
		agentId: string;
	}): Promise<SetupState>;
};
