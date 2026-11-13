export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Above this many line pairs no diff is computed. */
const MAX_CELLS = 4_000_000;

/**
 * Line diff of two texts by longest common subsequence. Returns undefined when the texts are
 * too long to compare here, so the caller shows the new version in full instead.
 */
export function lineDiff(
	before: string,
	after: string,
): DiffLine[] | undefined {
	const a = before.split("\n"),
		b = after.split("\n");
	// Shared leading and trailing lines need no table.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length,
		endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA),
		midB = b.slice(start, endB);
	if (midA.length * midB.length > MAX_CELLS) return undefined;
	const width = midB.length + 1;
	const table = new Uint32Array((midA.length + 1) * width);
	for (let i = midA.length - 1; i >= 0; i--)
		for (let j = midB.length - 1; j >= 0; j--)
			table[i * width + j] =
				midA[i] === midB[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
	const lines: DiffLine[] = a
		.slice(0, start)
		.map((text) => ({ kind: "same", text }));
	let i = 0,
		j = 0;
	while (i < midA.length || j < midB.length) {
		if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
			lines.push({ kind: "same", text: midA[i] });
			i++;
			j++;
		} else if (
			i < midA.length &&
			(j === midB.length ||
				table[(i + 1) * width + j] >= table[i * width + j + 1])
		) {
			// Removed lines come before the lines that replace them.
			lines.push({ kind: "removed", text: midA[i] });
			i++;
		} else {
			lines.push({ kind: "added", text: midB[j] });
			j++;
		}
	}
	for (const text of a.slice(endA)) lines.push({ kind: "same", text });
	return lines;
}
