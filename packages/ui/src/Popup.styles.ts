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

const fade = stylex.keyframes({
	from: { opacity: 0 },
	to: { opacity: 1 },
});

/** A dialog card arrives a touch small and low, then settles. */
const arrive = stylex.keyframes({
	from: { opacity: 0, transform: "translateY(6px) scale(0.97)" },
	to: { opacity: 1, transform: "none" },
});

/** Shared surface and entrance for dialogs, menus and select popups. */
export const popupStyles = stylex.create({
	/**
	 * Menus and select popups grow a touch from the side they open from and settle; closing,
	 * the whole popup shrinks back toward that origin as it fades, so it leaves as one object.
	 * Pair with `popupClassName`, which applies the starting and ending states.
	 */
	motion: {
		transformOrigin: "var(--transform-origin)",
		transitionProperty: {
			default: "opacity, transform",
			[reducedMotion]: "opacity",
		},
		transitionDuration: `${motion.slow}, ${motion.enter}`,
		transitionTimingFunction: `ease-out, ${motion.settle}`,
	},
	starting: { opacity: 0, transform: "scale(0.96)" },
	ending: {
		opacity: 0,
		transform: "scale(0.96)",
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeIn,
	},
	/** 240ms rise and settle for dialog cards. */
	dialogEnter: {
		transformOrigin: "50% 40%",
		animationName: { default: arrive, [reducedMotion]: fade },
		animationDuration: motion.enter,
		animationTimingFunction: motion.settle,
		animationFillMode: "both",
	},
	/** Dimmed page behind a dialog (50% cool navy ink in light, 65% black in dark); fades in with the card. */
	backdrop: {
		backgroundColor: colors.backdrop,
		animationName: { default: fade, [reducedMotion]: "none" },
		animationDuration: motion.enter,
		animationTimingFunction: "ease-out",
		animationFillMode: "both",
	},
	menu: {
		minWidth: 200,
		maxWidth: "min(280px, var(--available-width))",
		padding: space.s1,
		backgroundColor: colors.popover,
		color: colors.text,
		borderRadius: geometry.corner,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		boxShadow: elevation.medium,
		outline: "none",
	},
	positioner: { zIndex: 10001, maxWidth: "calc(100vw - 16px)" },
	item: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minHeight: size.control,
		padding: "6px 10px",
		borderRadius: geometry.corner,
		cursor: "pointer",
		userSelect: "none",
		outline: "none",
	},
	highlighted: {
		backgroundColor: colors.hoverOverlay,
		boxShadow: elevation.itemRing,
	},
	danger: { color: colors.bad },
	dangerHighlighted: { backgroundColor: colors.badTint },
	disabled: { opacity: 0.55, cursor: "not-allowed" },
	separator: {
		height: 1,
		marginBlock: space.s1,
		marginInline: space.s1,
		backgroundColor: colors.line,
	},
});

/**
 * Class name callback for a Base UI popup: the shared enter/exit motion plus the given styles.
 * Base UI keeps the popup mounted until the ending transition has finished.
 */
export function popupClassName(...styles: stylex.StyleXStyles[]) {
	return (state: { transitionStatus?: string }) =>
		stylex.props(
			...styles,
			popupStyles.motion,
			state.transitionStatus === "starting" && popupStyles.starting,
			state.transitionStatus === "ending" && popupStyles.ending,
		).className ?? "";
}
