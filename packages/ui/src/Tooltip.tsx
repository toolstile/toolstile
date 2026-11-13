import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { popupStyles } from "./Popup.styles";
import {
	colors,
	elevation,
	geometry,
	motion,
	space,
	text,
} from "./tokens.stylex";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

/** Shares one open delay, so moving along a row of icons shows each label at once. */
export const TooltipProvider = BaseTooltip.Provider;

/**
 * The dashboard tooltip: a short dark label beside an icon-only control, on hover and keyboard
 * focus. The child keeps its own accessible name; the wrapper only anchors the label.
 */
export function Tooltip({
	label,
	side = "top",
	anchorStyle,
	children,
}: {
	label: ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	/** Extra styles for the wrapper, such as hiding it on phones along with its control. */
	anchorStyle?: stylex.StyleXStyles;
	children: ReactNode;
}) {
	return (
		<BaseTooltip.Root>
			<BaseTooltip.Trigger
				delay={300}
				render={<span {...stylex.props(styles.anchor, anchorStyle)} />}
			>
				{children}
			</BaseTooltip.Trigger>
			<BaseTooltip.Portal>
				<BaseTooltip.Positioner
					side={side}
					sideOffset={8}
					collisionPadding={8}
					{...stylex.props(popupStyles.positioner)}
				>
					<BaseTooltip.Popup {...stylex.props(tooltipStyles.label)}>
						{label}
					</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	);
}

const enter = stylex.keyframes({
	from: { opacity: 0, transform: "scale(0.96)" },
	to: { opacity: 1, transform: "none" },
});

/** The label's look; the compact rail's CSS tooltip uses the same values. */
const tooltipStyles = stylex.create({
	label: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s1,
		paddingBlock: 4,
		paddingInline: space.s2,
		borderRadius: geometry.cornerSmall,
		backgroundColor: colors.text,
		color: colors.page,
		boxShadow: elevation.medium,
		fontFamily: geometry.fontSans,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		whiteSpace: "nowrap",
		animationName: { default: enter, [reducedMotion]: "none" },
		animationDuration: motion.fast,
		animationTimingFunction: motion.easeOut,
	},
});

const styles = stylex.create({
	anchor: { display: "inline-flex", flexShrink: 0 },
});
