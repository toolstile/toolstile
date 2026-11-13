import type { BlockNode, InlineNode } from "@tanstack/markdown";
import { parseMarkdown } from "@tanstack/markdown/parser";

/** One explicit URL policy for authored and upstream Markdown. No executable/relative-host URLs. */
export function markdownUrl(value: string): string {
	if (
		!value ||
		value.includes("\\") ||
		/&(?:#[xX]?[0-9a-f]+|[a-z]+);/i.test(value) ||
		[...value].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		value.trim().startsWith("//")
	)
		return "";
	const safe = value.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(safe) && !/^(https?:|mailto:)/i.test(safe))
		return "";
	return safe;
}

function inline(nodes: InlineNode[]): string {
	return nodes
		.map((node): string => {
			if ("children" in node) return inline(node.children);
			if (node.type === "image") return node.alt;
			if (node.type === "break") return " ";
			if (node.type === "footnoteReference") return "";
			return node.value;
		})
		.join("");
}
function block(nodes: BlockNode[]): string {
	return nodes
		.map((node): string => {
			switch (node.type) {
				case "heading":
				case "paragraph":
					return inline(node.children);
				case "code":
				case "html":
					return node.value;
				case "list":
				case "footnotes":
					return node.items.map((item) => block(item.children)).join(" ");
				case "table":
					return [node.header, ...node.rows]
						.map((row) => row.map((cell) => inline(cell.children)).join(" "))
						.join(" ");
				case "thematicBreak":
					return "";
				default:
					return block(node.children);
			}
		})
		.join(" ");
}
/** Parse once per description, then display plain text in compact permission rows. */
export function markdownText(source: string): string {
	return block(
		parseMarkdown(source, { headingIds: false, frontmatter: false }).children,
	)
		.replace(/\s+/g, " ")
		.trim();
}
