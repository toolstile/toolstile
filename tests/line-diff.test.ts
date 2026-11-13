import { expect, it } from "vitest";
import { lineDiff } from "../packages/ui/src/line-diff";

it("marks added and removed lines around unchanged ones", () => {
	expect(lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne")).toEqual([
		{ kind: "same", text: "a" },
		{ kind: "removed", text: "b" },
		{ kind: "added", text: "B" },
		{ kind: "same", text: "c" },
		{ kind: "same", text: "d" },
		{ kind: "added", text: "e" },
	]);
	expect(lineDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
});

it("gives up on inputs too large to compare", () => {
	const many = (prefix: string) =>
		Array.from({ length: 3000 }, (_, i) => `${prefix}${i}`).join("\n");
	expect(lineDiff(many("a"), many("b"))).toBeUndefined();
});
