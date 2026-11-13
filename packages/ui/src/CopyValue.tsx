import { CopyIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useState } from "react";
import { controls } from "./Control.styles";
import { colors, geometry, space, text } from "./tokens.stylex";

/**
 * A value to copy, such as a token, link or endpoint, in a recessed well with its copy button
 * beside it. The button reads "Copied" briefly after a copy; `children` adds further actions.
 */
export function CopyValue({
	value,
	display,
	copyLabel = "Copy",
	autoFocus = false,
	onCopied,
	onCopyFailed,
	children,
}: {
	value: string;
	/** Rendered in the well instead of the raw value, such as a highlighted URL. */
	display?: ReactNode;
	copyLabel?: string;
	/** Focuses the copy button when a dialog opens. */
	autoFocus?: boolean;
	onCopied?(): void;
	onCopyFailed?(): void;
	children?: ReactNode;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div {...stylex.props(styles.row)}>
			{display === undefined ? (
				<code {...stylex.props(styles.value, styles.code)}>{value}</code>
			) : (
				<span {...stylex.props(styles.value)}>{display}</span>
			)}
			<button
				{...stylex.props(controls.button)}
				type="button"
				data-autofocus={autoFocus || undefined}
				onClick={() =>
					navigator.clipboard
						.writeText(value)
						.then(() => {
							setCopied(true);
							onCopied?.();
						})
						.catch(() => onCopyFailed?.())
				}
			>
				<CopyIcon size={16} aria-hidden="true" />
				{copied ? "Copied" : copyLabel}
			</button>
			{children}
		</div>
	);
}

const styles = stylex.create({
	row: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: space.s2,
		minWidth: 0,
		maxWidth: "100%",
	},
	value: {
		flex: "1 1 240px",
		minWidth: 0,
		margin: 0,
		paddingBlock: 6,
		paddingInline: 10,
		borderRadius: geometry.corner,
		backgroundColor: colors.insetTint,
		overflowWrap: "anywhere",
	},
	code: {
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
});
