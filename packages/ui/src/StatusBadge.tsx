import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { type StatusTone, statusLabel, statusTone } from "./status";
import { colors, geometry, motion } from "./tokens.stylex";

export { type StatusTone, statusLabel, statusTone } from "./status";

/** Small dot-and-label badge. Shows the fixed label and keeps the raw status in its title. */
export function StatusBadge({
	status,
	tone = statusTone(status),
	children,
}: {
	status: string;
	tone?: StatusTone;
	children?: ReactNode;
}) {
	return (
		<span title={status} {...stylex.props(styles.badge, styles[tone])}>
			<span aria-hidden="true" {...stylex.props(styles.dot)} />
			{children ?? statusLabel(status)}
		</span>
	);
}

const styles = stylex.create({
	// One status style everywhere: a 6px semantic dot and a medium label, no pill.
	badge: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		flexShrink: 0,
		height: 20,
		fontFamily: geometry.fontSans,
		fontSize: 13,
		lineHeight: "20px",
		fontWeight: 400,
		whiteSpace: "nowrap",
		fontVariantNumeric: "tabular-nums",
		transitionProperty: {
			default: "color",
			"@media (prefers-reduced-motion: reduce)": "none",
		},
		transitionDuration: "400ms",
	},
	dot: {
		width: 6,
		height: 6,
		borderRadius: "50%",
		backgroundColor: "var(--badge-dot, currentColor)",
		flexShrink: 0,
		// A status that changes in place (connecting to connected) eases to its new colour.
		transitionProperty: {
			default: "background-color",
			"@media (prefers-reduced-motion: reduce)": "none",
		},
		transitionDuration: "400ms",
		transitionTimingFunction: motion.easeOut,
	},
	// The dot carries the meaning; the label is plain 13px text so a column of statuses reads
	// as a list. Only neutral (unknown) states drop to secondary.
	good: { color: colors.text, "--badge-dot": colors.good },
	warning: { color: colors.text, "--badge-dot": colors.warning },
	action: { color: colors.text, "--badge-dot": colors.action },
	bad: { color: colors.text, "--badge-dot": colors.bad },
	neutral: { color: colors.muted },
});
