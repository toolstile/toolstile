import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@stylexjs/stylex", () => ({
	create: <T,>(value: T) => value,
	defineVars: <T,>(value: T) => value,
	props: () => ({}),
}));

import { ConnectionMark } from "./ConnectionMark";
import { ConnectorLogo } from "./ConnectorLogo";
import { MarkdownContent, MarkdownPreview } from "./MarkdownContent";
import { markdownText, markdownUrl } from "./markdown";

describe("shared Markdown", () => {
	it("produces readable previews from nested Markdown, code, tables and links", () => {
		expect(
			markdownText(
				"**Purpose:** Retrieve `content` from [the editor](https://example.com).\n\n- **Read** it\n- ~~Old~~ text",
			),
		).toBe("Purpose: Retrieve content from the editor. Read it Old text");
		expect(
			markdownText("| Name | State |\n| --- | --- |\n| **One** | `Ready` |"),
		).toBe("Name State One Ready");
		const output = renderToStaticMarkup(
			<MarkdownPreview source="**Purpose:** Read `content`" />,
		);
		expect(output).toContain('title="Purpose: Read content"');
		expect(output).not.toContain("**");
	});
	it.each([
		"javascript:alert(1)",
		" javascript:alert(1)",
		"data:text/html,unsafe",
		"//attacker.test",
		"https:\\attacker.test",
		"java\tscript:alert(1)",
	])("rejects unsafe URL %s", (value) => expect(markdownUrl(value)).toBe(""));
	it("renders formatting without enabling executable URLs, raw HTML or remote images", () => {
		const output = renderToStaticMarkup(
			<MarkdownContent>
				{
					"**Purpose:** Read `content`\n\n[Safe](https://example.com) [bad](javascript:alert) [entity](javascript&#58;alert)\n\n<img src=x onerror=alert(1)>\n\n![tracker](https://attacker.test/pixel)\n\n```sh\necho safe\n```"
				}
			</MarkdownContent>,
		);
		expect(output).toContain("<strong>Purpose:</strong>");
		expect(output).toContain('href="https://example.com"');
		expect(output).not.toMatch(
			/<img|<script|href="javascript|src="https:\/\/attacker/,
		);
		expect(output).toContain("&lt;img");
		expect(output).toContain("echo safe");
	});
});

describe("connection artwork", () => {
	const url = "/connector-logos/docs-0123456789abcdef.svg";
	it("shows a catalog logo only as a same-origin image URL, loaded lazily", () => {
		const output = renderToStaticMarkup(<ConnectorLogo logoUrl={url} />);
		expect(output).toContain(`src="${url}"`);
		expect(output).toContain('loading="lazy"');
		expect(output).toContain('decoding="async"');
		expect(output).toContain('width="28"');
		expect(
			renderToStaticMarkup(<ConnectorLogo logoUrl={url} eager />),
		).toContain('loading="eager"');
	});
	it.each([
		"data:image/svg+xml,%3Csvg%3E",
		"https://attacker.example/logo.svg",
		"javascript:alert(1)",
		null,
	])("falls back to a generic mark for %s", (logoUrl) => {
		const output = renderToStaticMarkup(<ConnectorLogo logoUrl={logoUrl} />);
		expect(output).not.toContain("<img");
	});
	it("uses the server-matched logo, else the monogram", () => {
		expect(
			renderToStaticMarkup(
				<ConnectionMark label="Docs" url="https://a.example" logoUrl={url} />,
			),
		).toContain("<img");
		expect(
			renderToStaticMarkup(
				<ConnectionMark label="Docs" url="https://a.example" />,
			),
		).toContain(">D<");
	});
});
