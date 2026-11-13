import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";
import { colors, geometry, motion, size, space, text } from "./tokens.stylex";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

export type CheckboxProps = Omit<
	ComponentProps<typeof BaseCheckbox.Root>,
	"className" | "style" | "render"
> & {
	/** A softer tint for access that comes from elsewhere, such as an inherited rule. */
	inherited?: boolean;
	xstyle?: stylex.StyleXStyles;
};

/**
 * The checkbox for every Toolstile screen. Wrap it in a `<label>` with its text; it keeps a
 * hidden input, so `name`, `value` and `required` work inside forms.
 */
export function Checkbox({
	inherited = false,
	xstyle,
	indeterminate,
	...props
}: CheckboxProps) {
	return (
		<BaseCheckbox.Root
			{...props}
			indeterminate={indeterminate}
			className={(state) =>
				stylex.props(
					styles.box,
					(state.checked || state.indeterminate) &&
						(inherited ? styles.inherited : styles.checked),
					state.disabled && styles.disabled,
					xstyle,
				).className ?? ""
			}
		>
			<BaseCheckbox.Indicator {...stylex.props(styles.indicator, styles.mark)}>
				{indeterminate ? (
					<MinusIcon size={12} weight="bold" />
				) : (
					<CheckIcon size={12} weight="bold" />
				)}
			</BaseCheckbox.Indicator>
		</BaseCheckbox.Root>
	);
}

/**
 * A checkbox with its label text. The box stays on the first line when the label wraps, and
 * the row keeps the control height so it lines up with inputs and buttons beside it.
 */
export function CheckboxField({
	children,
	labelStyle,
	...props
}: CheckboxProps & {
	children: ReactNode;
	labelStyle?: stylex.StyleXStyles;
}) {
	return (
		<label {...stylex.props(styles.field, labelStyle)}>
			<Checkbox {...props} xstyle={[styles.fieldBox, props.xstyle]} />
			{children}
		</label>
	);
}

/** A non-interactive checked box for legends and keys. */
export function CheckboxSample({ inherited = false }: { inherited?: boolean }) {
	return (
		<span
			aria-hidden="true"
			{...stylex.props(
				styles.box,
				inherited ? styles.inherited : styles.checked,
				styles.sample,
			)}
		>
			<CheckIcon size={12} weight="bold" {...stylex.props(styles.indicator)} />
		</span>
	);
}

/** The mark pops in from a little smaller as the box fills. */
const pop = stylex.keyframes({
	from: { opacity: 0, transform: "scale(0.5)" },
	to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
	box: {
		display: "inline-grid",
		placeItems: "center",
		flexShrink: 0,
		boxSizing: "border-box",
		lineHeight: 0,
		width: size.check,
		height: size.check,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: {
			default: colors.inputBorder,
			":hover": colors.inputBorderHover,
			":focus-visible": colors.inputBorderHover,
		},
		borderRadius: geometry.cornerSmall,
		backgroundColor: colors.surface,
		color: colors.onFill,
		cursor: "pointer",
		outline: "none",
		transitionProperty: {
			default: "background-color, border-color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	checked: {
		borderColor: {
			default: colors.actionFill,
			":hover": colors.actionFillHover,
			":focus-visible": colors.actionFillHover,
		},
		backgroundColor: {
			default: colors.actionFill,
			":hover": colors.actionFillHover,
			":focus-visible": colors.actionFillHover,
		},
		color: colors.onFill,
	},
	// Reads as checked, one step quieter than a direct check.
	inherited: {
		borderColor: {
			default: "transparent",
			":hover": colors.inputBorderHover,
			":focus-visible": colors.inputBorderHover,
		},
		backgroundColor: colors.actionSoft,
		color: colors.action,
	},
	disabled: {
		cursor: "not-allowed",
		opacity: 0.5,
	},
	sample: { cursor: "default" },
	field: {
		display: "flex",
		alignItems: "flex-start",
		gap: space.s2,
		minHeight: size.control,
		paddingBlock: `calc((${size.control} - ${text.bodyLeading}) / 2)`,
		margin: 0,
		color: colors.text,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		fontWeight: 400,
		cursor: "pointer",
	},
	// Centres the box on the first line of a label that may wrap.
	fieldBox: { marginTop: `calc((${text.bodyLeading} - ${size.check}) / 2)` },
	// A grid with no line height, so the icon centres in the box whatever text surrounds it.
	indicator: { display: "grid", placeItems: "center", lineHeight: 0 },
	mark: {
		animationName: { default: pop, [reducedMotion]: "none" },
		animationDuration: motion.slow,
		animationTimingFunction: motion.settle,
	},
});
