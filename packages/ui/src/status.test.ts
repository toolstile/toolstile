import { describe, expect, it } from "vitest";
import {
	connectionNeedsSignIn,
	connectionStatus,
	connectionUnreachable,
	defaultAccessConnection,
	readServerAddress,
	sameServerAddress,
	specificMessage,
	toolsLoadable,
} from "./status";

describe("connectionStatus", () => {
	it("lets a tool check made in this browser replace an older status", () => {
		expect(connectionStatus("needs attention", "passed")).toBe("reachable");
		expect(connectionStatus("configured", "passed")).toBe("reachable");
		expect(connectionStatus("reachable", "failed")).toBe("needs attention");
		expect(connectionStatus("reachable")).toBe("reachable");
	});

	it("keeps sign-in states, which only signing in changes", () => {
		expect(connectionStatus("authentication required", "passed")).toBe(
			"authentication required",
		);
		expect(connectionStatus("authentication required", "failed")).toBe(
			"authentication required",
		);
	});

	it("treats only a failed check as unreachable; sign-in states can be finished", () => {
		expect(connectionUnreachable("Needs attention ")).toBe(true);
		expect(connectionUnreachable("authentication required")).toBe(false);
		expect(connectionUnreachable("reachable")).toBe(false);
		expect(connectionUnreachable("configured")).toBe(false);
	});
});

describe("specificMessage", () => {
	it("drops bare transport errors and keeps explanations", () => {
		expect(specificMessage(new Error("Internal server error"))).toBeUndefined();
		expect(specificMessage("Failed to fetch")).toBeUndefined();
		expect(specificMessage(new Error("Start the address with https://"))).toBe(
			"Start the address with https://",
		);
	});
});

describe("readServerAddress", () => {
	it("trims spaces and adds https:// when no scheme is given", () => {
		expect(readServerAddress("  mcp.deepwiki.com/mcp ")).toEqual({
			url: "https://mcp.deepwiki.com/mcp",
		});
		expect(readServerAddress("localhost:3000/mcp")).toEqual({
			url: "https://localhost:3000/mcp",
		});
		expect(readServerAddress("http://example.com/mcp")).toEqual({
			url: "http://example.com/mcp",
		});
	});

	it("explains what to change", () => {
		expect(readServerAddress(" ").error).toMatch(/Enter the MCP server/);
		expect(readServerAddress("javascript:alert(1)").error).toBe(
			"Start the address with https://.",
		);
		expect(readServerAddress("ftp://example.com").error).toBe(
			"Start the address with https://.",
		);
		expect(readServerAddress("not a url").error).toMatch(/full address/);
		expect(
			readServerAddress(`https://example.com/${"a".repeat(2048)}`).error,
		).toMatch(/too long/);
	});

	it("rejects a long pasted address instead of shortening it", () => {
		const pasted = `https://example.com/${"a".repeat(5000 - 20)}`;
		expect(pasted).toHaveLength(5000);
		expect(readServerAddress(pasted)).toEqual({
			url: pasted,
			error:
				"This address is too long. Use an address of up to 2,048 characters.",
		});
		// The limit counts the https:// added to a bare host.
		const bare = `example.com/${"a".repeat(2029)}`;
		expect(readServerAddress(bare).error).toMatch(/too long/);
		expect(readServerAddress(bare.slice(0, -1)).error).toBeUndefined();
	});
});

describe("sameServerAddress", () => {
	it("ignores host case and a trailing slash", () => {
		expect(
			sameServerAddress(
				"https://mcp.deepwiki.com/mcp",
				"https://MCP.deepwiki.com/mcp/",
			),
		).toBe(true);
		expect(
			sameServerAddress(
				"https://mcp.deepwiki.com/mcp",
				"https://mcp.deepwiki.com/sse",
			),
		).toBe(false);
	});
});

describe("defaultAccessConnection", () => {
	it("opens on the first connection Toolstile can reach", () => {
		const broken = { id: "a", status: "needs attention" };
		const working = { id: "b", status: "reachable" };
		expect(defaultAccessConnection([broken, working])).toBe(working);
		expect(defaultAccessConnection([broken])).toBe(broken);
		expect(defaultAccessConnection([])).toBeUndefined();
	});
});

describe("connectionNeedsSignIn", () => {
	it("is true only for browser sign-in connections without working sign-in", () => {
		const oauth = "oauth";
		expect(
			connectionNeedsSignIn({
				status: "authentication required",
				authentication: oauth,
			}),
		).toBe(true);
		expect(
			connectionNeedsSignIn({
				status: "needs reconnection",
				authentication: oauth,
			}),
		).toBe(true);
		expect(
			connectionNeedsSignIn({ status: "authenticated", authentication: oauth }),
		).toBe(false);
		expect(
			connectionNeedsSignIn({
				status: "authentication required",
				authentication: "headers",
			}),
		).toBe(false);
	});
});

describe("toolsLoadable", () => {
	it("loads tools only for connections that are reachable and signed in", () => {
		expect(toolsLoadable("reachable")).toBe(true);
		expect(toolsLoadable(" Authenticated ")).toBe(true);
		for (const status of [
			"authentication required",
			"needs attention",
			"configured",
			"approval pending",
		])
			expect(toolsLoadable(status)).toBe(false);
	});
});
