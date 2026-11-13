import * as stylex from "@stylexjs/stylex";
import { Markdown, type MarkdownComponents } from "@tanstack/markdown/react";
import { useMemo } from "react";
import { markdownText, markdownUrl } from "./markdown";
import { colors, geometry } from "./tokens.stylex";

export function MarkdownPreview({
	source,
	className,
}: {
	source: string;
	className?: string;
}) {
	const text = useMemo(() => markdownText(source), [source]);
	return (
		<span className={className} title={text}>
			{text}
		</span>
	);
}

/** Upstream descriptions are untrusted: no raw HTML, remote images or HTML-string rendering. */
export function MarkdownContent({ children }: { children: string }) {
	return (
		<div {...stylex.props(s.body)}>
			<Markdown
				frontmatter={false}
				headingIds={false}
				urlTransform={(_value, _kind, defaultUrl) => markdownUrl(defaultUrl)}
				components={components}
			>
				{children}
			</Markdown>
		</div>
	);
}
const components = {
	p: ({ children }) => <p {...stylex.props(s.paragraph)}>{children}</p>,
	a: ({ children, href }) =>
		href ? (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				{...stylex.props(s.link)}
			>
				{children}
			</a>
		) : (
			<span>{children}</span>
		),
	img: ({ alt }) => <span>{alt}</span>,
	pre: ({ children }) => <pre {...stylex.props(s.pre)}>{children}</pre>,
	code: ({ children }) => <code {...stylex.props(s.code)}>{children}</code>,
	ul: ({ children }) => <ul {...stylex.props(s.list)}>{children}</ul>,
	ol: ({ children, start }) => (
		<ol start={start} {...stylex.props(s.list)}>
			{children}
		</ol>
	),
	strong: ({ children }) => (
		<strong {...stylex.props(s.strong)}>{children}</strong>
	),
} satisfies MarkdownComponents;
const s = stylex.create({
	body: {
		color: colors.muted,
		fontSize: 14,
		lineHeight: 1.6,
		overflowWrap: "anywhere",
	},
	paragraph: { marginBlock: 8, color: colors.muted },
	link: { color: colors.action, textDecoration: "underline" },
	pre: {
		overflowX: "auto",
		whiteSpace: "pre-wrap",
		padding: 12,
		backgroundColor: colors.insetTint,
		borderRadius: geometry.corner,
	},
	code: { fontFamily: geometry.fontMono, fontSize: "0.9em" },
	list: { paddingInlineStart: 24, marginBlock: 8 },
	strong: { color: colors.text, fontWeight: 600 },
});
