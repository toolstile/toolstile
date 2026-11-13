import { describe, expect, it } from "vitest";
import { formatApprovalParameters } from "./approval-parameters";

describe("exact approval parameter presentation", () => {
	it("keeps ordinary JSON, quotes, line breaks and multilingual text readable", () => {
		const value = {
			name: "create_issue",
			arguments: {
				title: 'Invoice "draft"\nReview',
				label: "فاتورة · 日本語",
				amount: 42,
			},
		};
		const result = formatApprovalParameters(value);
		expect(result).toEqual({
			text: JSON.stringify(value, null, 2),
			hasHiddenCharacters: false,
		});
		expect(JSON.parse(result.text)).toEqual(value);
	});
	it.each([
		"\u202e",
		"\ufff9",
		"\ufffa",
		"\ufffb",
		"\u0600",
		"\u202d",
		"\u2066",
		"\u2067",
		"\u2068",
		"\u2069",
		"\u200b",
		"\u200d",
		"\ufeff",
		"\u00ad",
		"\u034f",
		"\ufe0f",
		"\u2028",
		"\u2029",
		"\u00a0",
		"\u007f",
		"\u0085",
		"\u{e0061}",
	])(
		"escapes hidden or direction-changing character %j in keys and values",
		(character) => {
			const value = {
				arguments: { [`file${character}`]: `invoice${character}fdp.exe` },
			};
			const result = formatApprovalParameters(value);
			expect(result.hasHiddenCharacters).toBe(true);
			expect(result.text).not.toContain(character);
			expect(result.text).toContain("\\u");
			// This is a display transformation, never a different call for approval.
			expect(JSON.parse(result.text)).toEqual(value);
		},
	);
	it("distinguishes an actual control from a literal backslash-u escape", () => {
		const result = formatApprovalParameters({
			actual: "a\u202eb",
			literal: "a\\u202eb",
		});
		expect(result.text).toContain('"actual": "a\\u202eb"');
		expect(result.text).toContain('"literal": "a\\\\u202eb"');
		expect(JSON.parse(result.text)).toEqual({
			actual: "a\u202eb",
			literal: "a\\u202eb",
		});
	});
});
