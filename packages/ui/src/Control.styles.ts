import * as stylex from "@stylexjs/stylex";
import {
	colors,
	elevation,
	geometry,
	motion,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

/** Intrinsic form controls shared by Toolstile screens. */
export const controls = stylex.create({
	/**
	 * Secondary tier: surface fill and hairline edge; in dark a top-lit sheen, 20% white ring and
	 * inner highlight. Add primary or quiet for the other tiers. Disabled stays flat.
	 */
	button: {
		minHeight: size.control,
		minWidth: size.control,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: {
			default: colors.controlBorder,
			":hover": colors.controlBorderHover,
			":focus-visible": colors.controlBorderHover,
			":disabled": colors.controlBorder,
		},
		borderRadius: geometry.corner,
		backgroundColor: {
			default: colors.controlFill,
			":hover": colors.controlFillHover,
			":focus-visible": colors.controlFillHover,
		},
		backgroundImage: { default: elevation.controlSheen, ":disabled": "none" },
		boxShadow: { default: elevation.controlShadow, ":disabled": "none" },
		color: colors.text,
		padding: `6px ${space.s3}`,
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.55 },
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		whiteSpace: "normal",
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 500,
		flexShrink: 0,
		transitionProperty: {
			default: "background-color, border-color, color, box-shadow, transform",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
		transform: {
			default: null,
			":active": { default: "scale(0.98)", [reducedMotion]: "none" },
		},
	},
	/** Filled action with white text; the brand blue, one step lighter in dark. Keep one per page. */
	primary: {
		backgroundColor: {
			default: colors.actionFill,
			":hover": colors.actionFillHover,
			":focus-visible": colors.actionFillHover,
		},
		// The interface's single accent gradient: a soft top highlight on the fill.
		backgroundImage: elevation.primarySheen,
		color: colors.onFill,
		borderColor: {
			default: colors.actionFill,
			":hover": colors.actionFillHover,
			":focus-visible": colors.actionFillHover,
		},
		boxShadow: {
			default: `${elevation.primaryHighlight}, ${elevation.primaryShadow}`,
			":hover": `${elevation.primaryHighlight}, ${elevation.primaryShadowHover}`,
			":focus-visible": `${elevation.primaryHighlight}, ${elevation.primaryShadowHover}`,
		},
		filter: {
			default: "none",
			":hover": elevation.fillHoverFilter,
			":focus-visible": elevation.fillHoverFilter,
		},
	},
	/** Ghost tier for per-row actions; the ring appears on hover. */
	quiet: {
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		backgroundImage: "none",
		borderColor: {
			default: "transparent",
			":hover": colors.controlBorder,
			":focus-visible": colors.controlBorder,
		},
		boxShadow: "none",
	},
	/** Quiet destructive tier for Disconnect and Remove. */
	quietDanger: {
		backgroundColor: {
			default: "transparent",
			":hover": colors.badTint,
			":focus-visible": colors.badTint,
		},
		backgroundImage: "none",
		borderColor: "transparent",
		boxShadow: "none",
		color: colors.bad,
	},
	/** Filled destructive tier for the confirming action of a destructive dialog. */
	destructive: {
		backgroundColor: {
			default: colors.badFill,
			":hover": colors.badFillHover,
			":focus-visible": colors.badFillHover,
		},
		backgroundImage: "none",
		borderColor: colors.badFill,
		color: colors.onFill,
		boxShadow: {
			default: elevation.dangerShadow,
			":hover": elevation.dangerShadowHover,
			":focus-visible": elevation.dangerShadowHover,
		},
		filter: {
			default: "none",
			":hover": elevation.fillHoverFilter,
			":focus-visible": elevation.fillHoverFilter,
		},
	},
	/** 28px (44 on coarse pointers) for row and toolbar actions; combine with `button`. */
	small: {
		minHeight: size.controlSm,
		minWidth: size.controlSm,
		padding: `${space.s1} ${space.s2}`,
		gap: space.s1,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	/**
	 * 40px (44 on coarse pointers) for account and marketing screens; combine with `button` or
	 * `input`. Text is 14/20, or the larger input size so coarse-pointer inputs keep 16px.
	 */
	large: {
		minHeight: size.controlLg,
		minWidth: size.controlLg,
		fontSize: `max(${typeScale.size14}, ${text.input})`,
		lineHeight: typeScale.leading14,
	},
	/** Square icon button; combine with `button` and optionally `small` or `large`. */
	iconOnly: { padding: 0, gap: 0 },
	danger: { color: colors.bad },
	input: {
		width: "100%",
		backgroundColor: colors.input,
		color: colors.text,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: {
			default: colors.inputBorder,
			":hover": colors.inputBorderHover,
			":focus-visible": colors.action,
		},
		"::placeholder": { color: colors.muted, opacity: 0.8 },
		boxShadow: {
			default: elevation.inputShadow,
		},
		outline: "none",
		transitionProperty: {
			default: "border-color, box-shadow",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
		padding: "6px 10px",
		borderRadius: geometry.corner,
		minHeight: size.control,
		fontFamily: geometry.fontSans,
		fontSize: text.input,
		lineHeight: text.bodyLeading,
	},
	textarea: {
		width: "100%",
		backgroundColor: colors.input,
		color: colors.text,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: {
			default: colors.inputBorder,
			":hover": colors.inputBorderHover,
			":focus-visible": colors.action,
		},
		"::placeholder": { color: colors.muted, opacity: 0.8 },
		boxShadow: {
			default: elevation.inputShadow,
		},
		outline: "none",
		transitionProperty: {
			default: "border-color, box-shadow",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
		padding: "6px 10px",
		borderRadius: geometry.corner,
		minHeight: size.control,
		resize: "vertical",
		fontFamily: geometry.fontSans,
		fontSize: text.input,
		lineHeight: text.bodyLeading,
	},
	label: {
		display: "grid",
		gap: space.s1,
		fontWeight: 500,
		// Textarea fields sit in gap-spaced grids (policy rules) or beside blocks that carry their
		// own margins, so a margin here only adds a second gap below them.
		margin: { default: "var(--field-gap) 0", ":has(> textarea)": 0 },
	},
	optional: { fontWeight: 400, color: colors.muted, fontSize: text.meta },
	error: { color: colors.bad },
	/** Borderless field group: a 13/18 semibold legend over its fields, no frame. */
	fieldset: {
		borderWidth: 0,
		margin: `${space.s4} 0`,
		padding: 0,
		minWidth: 0,
		display: "grid",
		gap: space.s2,
	},
	legend: {
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 600,
		padding: 0,
		marginBottom: space.s2,
	},
	pre: {
		overflow: "auto",
		backgroundColor: colors.insetTint,
		padding: space.s3,
		borderRadius: geometry.corner,
		maxWidth: "100%",
	},
});
