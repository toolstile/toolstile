import type { SetupClient } from "../../setup-contract";
import agentcore from "./agentcore.svg";
import chatgpt from "./chatgpt.png";
import claude from "./claude.svg";
import cline from "./cline.svg";
import codex from "./codex.png";
import copilot from "./copilot.png";
import cursor from "./cursor.svg";
import gemini from "./gemini.png";
import goose from "./goose.svg";
import mcpjam from "./mcpjam.png";
import mistral from "./mistral.svg";
import n8n from "./n8n.svg";
import notion from "./notion.png";
import perplexity from "./perplexity.png";
import slack from "./slack.png";
import vscode from "./vscode.svg";
import windsurf from "./windsurf.svg";

/** Each agent app's mark; provenance is in docs/artwork.md. */
export const agentMarks: Record<SetupClient, string> = {
	"claude-code": claude,
	codex,
	cursor,
	vscode,
	"gemini-cli": gemini,
	cline,
	windsurf,
	goose,
	claude,
	"claude-desktop": claude,
	chatgpt,
	copilot,
	"le-chat": mistral,
	perplexity,
	notion,
	slackbot: slack,
	mcpjam,
	n8n,
	agentcore,
};

/** Single-colour black marks, inverted on the dark tile. */
export const monochromeMarks = new Set<SetupClient>(["cursor", "cline"]);
