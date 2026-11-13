import { describe, expect, it } from "vitest";
import { discardLegacyDialogSearch } from "./dashboard-local-dialogs";

describe("discardLegacyDialogSearch", () => {
	it("discards all former dialog and guided setup parameters", () => {
		expect(
			discardLegacyDialogSearch(
				"?dialog=grant&agentId=a&connectionId=c&toolName=t&accountAction=delete&accessScope=all-agents&setupStep=access&setupClient=codex&setupConnectionId=c&setupAgentId=a",
			),
		).toBe("");
	});

	it("preserves auth, invitation, OAuth and inline record state exactly", () => {
		const retained =
			"invite=invite%2Bvalue&email=a%2Bb%40example.test&authMode=signup&oauth=connected&state=opaque%2b%20value&code=protocol-value&redirect_uri=%2Foauth%2Fcallback&debugPayloadId=record&filter=recent&filter=failed";
		expect(
			discardLegacyDialogSearch(`?dialog=agent&${retained}&setupStep=agent`),
		).toBe(`?${retained}`);
	});

	it("removes encoded and repeated legacy keys without changing other bytes", () => {
		expect(
			discardLegacyDialogSearch(
				"?%64ialog=agent&dialog=device&setup%53tep=connect&state=%ZZ+value&other=dialog%3Dagent",
			),
		).toBe("?state=%ZZ+value&other=dialog%3Dagent");
	});

	it("leaves clean queries untouched", () => {
		for (const search of ["", "?", "?oauth=failed&state=%2b+value"])
			expect(discardLegacyDialogSearch(search)).toBe(search);
	});
});
