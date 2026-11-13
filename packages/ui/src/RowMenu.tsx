import { Menu } from "@base-ui/react/menu";
import { DotsThreeIcon, type Icon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";
import { controls } from "./Control.styles";
import { popupClassName, popupStyles } from "./Popup.styles";

export type RowMenuItem = {
	label: string;
	onSelect(): void;
	icon?: Icon;
	danger?: boolean;
	disabled?: boolean;
};

/** Overflow menu for secondary row actions. Destructive items render last, after a separator. */
export function RowMenu({
	label,
	items,
	disabled,
	size,
}: {
	/** Accessible name for the trigger, e.g. "More actions for Linear". */
	label: string;
	items: RowMenuItem[];
	disabled?: boolean;
	/** `small` is a 28px trigger (44 on coarse pointers) for dense headers. */
	size?: "small";
}) {
	const safe = items.filter((item) => !item.danger);
	const destructive = items.filter((item) => item.danger);
	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label={label}
				title={label}
				disabled={disabled}
				{...stylex.props(
					controls.button,
					controls.quiet,
					size === "small" && controls.small,
					controls.iconOnly,
					styles.trigger,
				)}
			>
				<DotsThreeIcon
					size={size === "small" ? 16 : 18}
					weight="bold"
					aria-hidden="true"
				/>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					collisionPadding={8}
					{...stylex.props(popupStyles.positioner)}
				>
					<Menu.Popup className={popupClassName(popupStyles.menu)}>
						{[safe, destructive].map((group, index) =>
							group.length ? (
								<Fragment key={index ? "danger" : "safe"}>
									{index && safe.length ? (
										<Menu.Separator {...stylex.props(popupStyles.separator)} />
									) : null}
									{group.map((item) => (
										<Menu.Item
											key={item.label}
											disabled={item.disabled}
											onClick={item.onSelect}
											className={(state) =>
												stylex.props(
													popupStyles.item,
													item.danger && popupStyles.danger,
													state.highlighted &&
														(item.danger
															? popupStyles.dangerHighlighted
															: popupStyles.highlighted),
													state.disabled && popupStyles.disabled,
												).className
											}
										>
											{item.icon ? (
												<item.icon size={16} aria-hidden="true" />
											) : null}
											{item.label}
										</Menu.Item>
									))}
								</Fragment>
							) : null,
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

const styles = stylex.create({
	trigger: { color: "inherit" },
});
