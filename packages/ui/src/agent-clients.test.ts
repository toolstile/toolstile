import { describe, expect, it } from "vitest";
import { agentApps, detectAgentClient } from "./agent-clients";
import { setupClients } from "./setup-contract";

describe("agent app detection", () => {
	it("recognizes the client names agent apps register, with repeat suffixes", () => {
		expect(detectAgentClient("Codex")).toBe("codex");
		expect(detectAgentClient("Codex (3)")).toBe("codex");
		expect(detectAgentClient("codex-mcp-client")).toBe("codex");
		expect(detectAgentClient("Claude Code")).toBe("claude-code");
		expect(detectAgentClient("claude-code")).toBe("claude-code");
		expect(detectAgentClient("Claude")).toBe("claude-desktop");
		expect(detectAgentClient("Cursor")).toBe("cursor");
		expect(detectAgentClient("Visual Studio Code")).toBe("vscode");
		expect(detectAgentClient("gemini-cli-mcp-client")).toBe("gemini-cli");
		expect(detectAgentClient("Cline")).toBe("cline");
		expect(detectAgentClient("windsurf-client")).toBe("windsurf");
		expect(detectAgentClient("Devin Desktop")).toBe("windsurf");
		expect(detectAgentClient("goose")).toBe("goose");
		expect(detectAgentClient("openai-mcp")).toBe("chatgpt");
		expect(detectAgentClient("Microsoft Copilot Studio")).toBe("copilot");
		expect(detectAgentClient("Mistral Le Chat")).toBe("le-chat");
		expect(detectAgentClient("Perplexity")).toBe("perplexity");
		expect(detectAgentClient("Notion AI")).toBe("notion");
		expect(detectAgentClient("Slackbot")).toBe("slackbot");
		expect(detectAgentClient("mcpjam-inspector")).toBe("mcpjam");
		expect(detectAgentClient("n8n (2)")).toBe("n8n");
		expect(detectAgentClient("bedrock-agentcore-gateway")).toBe("agentcore");
	});
	it("leaves other names unrecognized", () => {
		expect(detectAgentClient("Local verification agent")).toBeUndefined();
		expect(detectAgentClient("Agent")).toBeUndefined();
		expect(detectAgentClient("Recursor")).toBeUndefined();
	});
	it("gives every app steps and marks each copyable block", () => {
		const apps = agentApps("https://mcp.example.com/mcp");
		expect(new Set(apps.map((app) => app.id)).size).toBe(setupClients.length);
		for (const app of apps) {
			expect(app.steps.length).toBeGreaterThan(0);
			for (const step of app.steps)
				if (step.code !== undefined) expect(step.codeKind).toBeTruthy();
		}
		const cursor = apps.find((app) => app.id === "cursor");
		const config = new URL(cursor?.install?.href ?? "").searchParams.get(
			"config",
		);
		expect(JSON.parse(atob(config ?? ""))).toEqual({
			url: "https://mcp.example.com/mcp",
		});
	});
});
