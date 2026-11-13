import { Menu } from "@base-ui/react/menu";
import {
	type Icon,
	MonitorIcon,
	MoonIcon,
	SunIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type KeyboardEvent, useRef } from "react";
import { type Theme, useAppearance } from "./Appearance";
import { colors, geometry, motion } from "./tokens.stylex";

const options = [
	{ value: "light", label: "Light", icon: SunIcon },
	{ value: "dark", label: "Dark", icon: MoonIcon },
	{ value: "system", label: "System", icon: MonitorIcon },
] as const satisfies readonly { value: Theme; label: string; icon: Icon }[];

const keySteps: Record<string, (index: number, last: number) => number> = {
	ArrowRight: (index, last) => (index === last ? 0 : index + 1),
	ArrowDown: (index, last) => (index === last ? 0 : index + 1),
	ArrowLeft: (index, last) => (index === 0 ? last : index - 1),
	ArrowUp: (index, last) => (index === 0 ? last : index - 1),
	Home: () => 0,
	End: (_, last) => last,
};

/**
 * Light / Dark / System as a compact icon segment: 24px cells on a 28px track (44px on touch).
 * Every placement shares the stored preference. Inside a Base UI menu pass `menu`, so the
 * segments become radio items the menu's arrow keys reach and choosing one keeps it open.
 * The chosen chip is drawn from the root `data-theme`, not React state, so it is right before hydration.
 */
export function ThemeSwitcher({ menu = false }: { menu?: boolean }) {
	const { theme, setTheme } = useAppearance();
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);

	if (menu)
		return (
			<Menu.RadioGroup
				aria-label="Theme"
				value={theme}
				onValueChange={(next: Theme) => setTheme(next)}
				{...stylex.props(styles.track, styles.trackMenu)}
			>
				{options.map(({ value, label, icon: OptionIcon }) => (
					<Menu.RadioItem
						key={value}
						value={value}
						aria-label={label}
						title={label}
						data-theme-option={value}
						className={(state) =>
							stylex.props(
								styles.segment,
								styles.segmentMenu,
								state.highlighted && styles.segmentHighlighted,
							).className
						}
					>
						{/* 16px, the size of the menu's row icons. */}
						<OptionIcon size={16} aria-hidden="true" />
					</Menu.RadioItem>
				))}
			</Menu.RadioGroup>
		);

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const step = keySteps[event.key];
		if (!step) return;
		event.preventDefault();
		const index = options.findIndex((option) => option.value === theme);
		const next = step(Math.max(index, 0), options.length - 1);
		setTheme(options[next].value);
		buttons.current[next]?.focus();
	}
	return (
		// oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- Roving focus: the checked radio is the tab stop, not the group.
		<div
			role="radiogroup"
			aria-label="Theme"
			onKeyDown={onKeyDown}
			{...stylex.props(styles.track)}
		>
			{options.map(({ value, label, icon: OptionIcon }, index) => {
				const checked = value === theme;
				return (
					// oxlint-disable-next-line toolstile/semantic-elements -- icon segments need button styling; roving focus and arrow keys follow the radio pattern.
					<button
						key={value}
						ref={(element) => {
							buttons.current[index] = element;
						}}
						type="button"
						role="radio"
						aria-checked={checked}
						aria-label={label}
						title={label}
						tabIndex={checked ? 0 : -1}
						onClick={() => setTheme(value)}
						data-theme-option={value}
						{...stylex.props(styles.segment, styles.segmentHover)}
					>
						<OptionIcon size={14} aria-hidden="true" />
					</button>
				);
			})}
		</div>
	);
}

const coarse = "@media (pointer: coarse)";

const styles = stylex.create({
	track: {
		display: "inline-flex",
		flexShrink: 0,
		gap: 0,
		padding: 2,
		borderRadius: 999,
		backgroundColor: colors.insetTint,
		boxShadow: `inset 0 0 0 1px ${colors.ring}`,
	},
	segment: {
		display: "inline-grid",
		placeItems: "center",
		width: { default: 24, [coarse]: 40 },
		height: { default: 24, [coarse]: 40 },
		padding: 0,
		borderWidth: 0,
		borderRadius: 999,
		backgroundColor: "transparent",
		color: colors.muted,
		cursor: "pointer",
		userSelect: "none",
		transitionProperty: "background-color, color, box-shadow",
		transitionDuration: motion.base,
		outlineWidth: 2,
		outlineStyle: { default: "none", ":focus-visible": "solid" },
		outlineColor: colors.action,
		outlineOffset: -2,
	},
	// In the account menu the segment follows the menu's 6px/4px corners, and its ring stays
	// below the menu's subtle dividers so the inset fill carries the boundary.
	trackMenu: {
		borderRadius: geometry.corner,
		boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${colors.ring} 60%, transparent)`,
	},
	segmentMenu: { borderRadius: geometry.cornerSmall },
	segmentHover: {
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
	},
	// Menu items take focus on hover too, so the highlight only lifts the icon; keyboard focus keeps the ring.
	segmentHighlighted: { color: colors.text },
	// The chosen segment's raised chip lives in styles.css, keyed to the root `data-theme`.
});
