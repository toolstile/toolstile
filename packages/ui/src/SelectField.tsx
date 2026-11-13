import { Select } from "@base-ui/react/select";
import { CaretUpDownIcon, CheckIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import { popupClassName } from "./Popup.styles";
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

export type SelectFieldProps = {
	items: { value: string; label: string; disabled?: boolean }[];
	value?: string | null;
	defaultValue?: string | null;
	onValueChange?: (value: string) => void;
	name?: string;
	disabled?: boolean;
	required?: boolean;
	id?: string;
	"aria-label"?: string;
	placeholder?: string;
	/** `large` is 40px (44 on coarse pointers) with 14px text, matching `controls.large` inputs. */
	size?: "large";
};

/** A themed, single-value select. Set defaultValue explicitly for uncontrolled forms. */
export function SelectField({
	items,
	value,
	defaultValue,
	onValueChange,
	name,
	disabled,
	required,
	id,
	"aria-label": ariaLabel,
	placeholder,
	size,
}: SelectFieldProps) {
	return (
		<Select.Root<string>
			items={items}
			value={value}
			defaultValue={defaultValue}
			onValueChange={(next) => onValueChange?.(next ?? "")}
			name={name}
			disabled={disabled}
			required={required}
		>
			<Select.Trigger
				id={id}
				aria-label={ariaLabel}
				{...stylex.props(styles.trigger, size === "large" && styles.large)}
			>
				<Select.Value
					placeholder={
						placeholder ??
						items.find((item) => item.value === "")?.label ??
						"Select an option"
					}
					{...stylex.props(styles.value)}
				/>
				<Select.Icon {...stylex.props(styles.icon)}>
					<CaretUpDownIcon size={16} aria-hidden="true" />
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner
					alignItemWithTrigger={false}
					align="start"
					sideOffset={4}
					collisionPadding={8}
					{...stylex.props(styles.positioner)}
				>
					<Select.Popup className={popupClassName(styles.popup)}>
						<Select.List {...stylex.props(styles.list)}>
							{items.map((item) => (
								<Select.Item
									key={item.value}
									value={item.value}
									label={item.label}
									disabled={item.disabled}
									className={(state) =>
										stylex.props(
											styles.item,
											state.highlighted && styles.highlighted,
											state.disabled && styles.disabled,
										).className
									}
								>
									<Select.ItemText {...stylex.props(styles.itemText)}>
										{item.label}
									</Select.ItemText>
									<Select.ItemIndicator {...stylex.props(styles.icon)}>
										<CheckIcon size={16} aria-hidden="true" />
									</Select.ItemIndicator>
								</Select.Item>
							))}
						</Select.List>
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
}

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
	large: {
		minHeight: size.controlLg,
		fontSize: `max(${typeScale.size14}, ${text.input})`,
		lineHeight: typeScale.leading14,
	},
	trigger: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s2,
		width: "100%",
		minWidth: 0,
		minHeight: size.control,
		padding: "6px 10px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: {
			default: colors.inputBorder,
			":hover": colors.inputBorderHover,
			":focus-visible": colors.action,
		},
		borderRadius: geometry.corner,
		// Shares the secondary button's fill, sheen and inner highlight; flat when disabled.
		backgroundColor: {
			default: colors.controlFill,
			":hover": colors.controlFillHover,
			":focus-visible": colors.controlFillHover,
		},
		backgroundImage: { default: elevation.controlSheen, ":disabled": "none" },
		color: colors.text,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		textAlign: "start",
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.55 },
		outline: "none",
		boxShadow: {
			default: elevation.controlShadow,
			":disabled": "none",
		},
		transitionProperty: {
			default: "background-color, border-color, box-shadow",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	value: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	icon: { display: "flex", alignItems: "center", flexShrink: 0 },
	positioner: { zIndex: 10001, maxWidth: "calc(100vw - 16px)" },
	popup: {
		width: "var(--anchor-width)",
		maxWidth: "var(--available-width)",
		maxHeight: "var(--available-height)",
		display: "flex",
		flexDirection: "column",
		backgroundColor: colors.popover,
		color: colors.text,
		borderRadius: geometry.corner,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		boxShadow: elevation.medium,
		outline: "none",
		overflow: "hidden",
	},
	list: {
		padding: space.s1,
		minHeight: 0,
		maxHeight: "min(320px, var(--available-height))",
		overflowY: "auto",
		overscrollBehavior: "contain",
		scrollPaddingBlock: space.s1,
	},
	item: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s2,
		minHeight: size.control,
		padding: "6px 10px",
		borderRadius: geometry.corner,
		cursor: "pointer",
		userSelect: "none",
		outline: "none",
	},
	itemText: { minWidth: 0, overflowWrap: "anywhere" },
	highlighted: {
		backgroundColor: colors.hoverOverlay,
		boxShadow: elevation.itemRing,
		color: colors.text,
	},
	disabled: { color: colors.muted, opacity: 0.55, cursor: "not-allowed" },
});

/** `SelectField` with a visible label above it, associated through the field id. */
export function SelectControl({
	label,
	id,
	...props
}: SelectFieldProps & { label: string }) {
	const generatedId = useId();
	const fieldId = id ?? generatedId;
	return (
		<div {...stylex.props(labelled.field)}>
			<label htmlFor={fieldId} {...stylex.props(labelled.text)}>
				{label}
			</label>
			<SelectField {...props} id={fieldId} />
		</div>
	);
}

const labelled = stylex.create({
	field: {
		display: "flex",
		flexDirection: "column",
		gap: space.s1,
		margin: 0,
		minWidth: 0,
		color: colors.text,
		fontWeight: 500,
	},
	text: { margin: 0, overflowWrap: "anywhere" },
});
