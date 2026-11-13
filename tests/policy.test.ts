import { describe, expect, it } from "vitest";
import { digest, issueToken, secretBox } from "../packages/auth/src/index";
import {
	alias,
	emptyRules,
	permitted,
	resourceAlias,
} from "../packages/gateway/src/index";

describe("capability policy", () => {
	it("blocks override full and additional grants for every capability", () => {
		for (const kind of ["tools", "resources", "prompts"] as const) {
			const full = emptyRules(),
				block = emptyRules();
			full.full = true;
			block.block[kind] = ["sensitive"];
			expect(permitted([full, block], kind, "sensitive")).toBe(false);
			expect(permitted([full, block], kind, "new-capability")).toBe(true);
		}
	});
	it("granular grants never imply other capabilities or future names", () => {
		const rule = emptyRules();
		rule.allow.tools = ["read"];
		expect(permitted([rule], "tools", "read")).toBe(true);
		expect(permitted([rule], "tools", "write")).toBe(false);
		expect(permitted([rule], "resources", "read")).toBe(false);
	});
	it("keeps aliases deterministic and separate between connections", () => {
		expect(alias("a", "read")).toBe(alias("a", "read"));
		expect(alias("a", "read")).not.toBe(alias("b", "read"));
		expect(resourceAlias("a", "file:///x")).not.toContain("file:///x");
	});
});
describe("credential protection", () => {
	it("authenticates ciphertext, uses unique nonces, and never stores clear tokens", () => {
		const box = secretBox("a".repeat(64)),
			original = { Authorization: "Bearer secret" };
		const encrypted = box.encrypt(original);
		expect(encrypted).not.toContain("secret");
		expect(box.encrypt(original)).not.toBe(encrypted);
		expect(box.decrypt(encrypted)).toEqual(original);
		const data = Buffer.from(encrypted, "base64url");
		data[data.length - 1] ^= 1;
		expect(() => box.decrypt(data.toString("base64url"))).toThrow();
		const token = issueToken();
		expect(digest(token)).not.toBe(token);
		expect(digest(token)).toHaveLength(64);
	});
	it("pins the 16-byte GCM tag and refuses truncated values", () => {
		const box = secretBox("a".repeat(64));
		const data = Buffer.from(box.encrypt({ value: "secret" }), "base64url");
		// IV (12) + 16-byte tag + ciphertext; decrypt pins that tag length, so this round-trips.
		expect(data.length).toBe(28 + JSON.stringify({ value: "secret" }).length);
		expect(box.decrypt(data.toString("base64url"))).toEqual({
			value: "secret",
		});
		// Too short to hold a full tag: never handed to GCM as a truncated tag.
		for (const length of [0, 12, 16, 27])
			expect(() =>
				box.decrypt(data.subarray(0, length).toString("base64url")),
			).toThrow("malformed");
	});
});
