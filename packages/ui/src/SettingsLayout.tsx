import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { layout } from "./Layout.styles";
import { PageHeader } from "./Primitives";
import {
	colors,
	geometry,
	motion,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

const narrowQuery = "(max-width: 760px)";
const narrow = "@media (max-width: 760px)";
const reducedMotion = "@media (prefers-reduced-motion: reduce)";

export interface SettingsNavigationItem {
	id: string;
	label: string;
	/** Route path for the subpage; each subpage is a real route. */
	to: string;
}
export interface SettingsNavigationGroup {
	label: string;
	items: SettingsNavigationItem[];
}
export interface SettingsLinkProps {
	id: string;
	to: string;
	className: string;
	children: ReactNode;
	"aria-current"?: "page";
}

/**
 * Settings shell: a second navigation column between the main sidebar and the selected subpage.
 * Under 760px the column becomes a horizontally scrolling tab row above the content.
 */
export function SettingsLayout({
	groups,
	current,
	renderLink,
	title,
	description,
	children,
}: {
	groups: SettingsNavigationGroup[];
	/** Id of the selected item. */
	current: string;
	/** Lets each app render its router link, such as TanStack `Link`. */
	renderLink(props: SettingsLinkProps): ReactNode;
	/** Subpage heading; defaults to the selected item's label. */
	title?: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	const baseId = useId();
	const navigationRef = useRef<HTMLElement>(null);
	const visible = groups.filter((group) => group.items.length);
	const heading =
		title ??
		visible.flatMap((group) => group.items).find((item) => item.id === current)
			?.label ??
		"Settings";
	// current changes aria-current in the DOM, so reveal the newly selected tab after navigation.
	useEffect(() => {
		// Keep the selected tab in view on the narrow scrolling row, including after a resize.
		const navigation = navigationRef.current;
		if (!navigation) return;
		function reveal() {
			const selected = navigation?.querySelector<HTMLElement>(
				'[aria-current="page"]',
			);
			if (!navigation || !selected || !matchMedia(narrowQuery).matches) return;
			const item = selected.getBoundingClientRect();
			const viewport = navigation.getBoundingClientRect();
			// Leave the row's inline padding (the page padding) visible beside the selected tab.
			const inset = Number.parseFloat(getComputedStyle(navigation).paddingLeft);
			if (item.left < viewport.left + inset)
				navigation.scrollLeft += item.left - viewport.left - inset;
			else if (item.right > viewport.right - inset)
				navigation.scrollLeft += item.right - viewport.right + inset;
		}
		reveal();
		const observer = new ResizeObserver(reveal);
		observer.observe(navigation);
		return () => observer.disconnect();
	}, [current]);
	return (
		<div {...stylex.props(styles.layout)}>
			<nav
				ref={navigationRef}
				aria-labelledby={`${baseId}-title`}
				data-scroll-restoration-id="settings-navigation"
				{...stylex.props(styles.navigation)}
			>
				{/* Names the navigation; the page title already says Settings visually. */}
				<p id={`${baseId}-title`} {...stylex.props(layout.visuallyHidden)}>
					Settings
				</p>
				{visible.map((group) => {
					return (
						<div key={group.label} {...stylex.props(styles.group)}>
							<p {...stylex.props(styles.groupLabel)}>{group.label}</p>
							{group.items.map((item) =>
								renderLink({
									id: item.id,
									to: item.to,
									className:
										stylex.props(
											styles.item,
											item.id === current && styles.itemSelected,
										).className ?? "",
									"aria-current": item.id === current ? "page" : undefined,
									children: item.label,
								}),
							)}
						</div>
					);
				})}
			</nav>
			<div {...stylex.props(styles.content)}>
				<PageHeader title={heading} description={description} />
				{children}
			</div>
		</div>
	);
}

const styles = stylex.create({
	layout: {
		display: { default: "grid", [narrow]: "block" },
		gridTemplateColumns: `${size.settingsNav} minmax(0, 1fr)`,
		minHeight: { default: "100dvh", [narrow]: 0 },
	},
	navigation: {
		position: { default: "sticky", [narrow]: "relative" },
		top: 0,
		alignSelf: "start",
		height: { default: "100dvh", [narrow]: "auto" },
		boxSizing: "border-box",
		display: "flex",
		flexDirection: { default: "column", [narrow]: "row" },
		gap: { default: space.s3, [narrow]: space.s1 },
		overflowX: { default: "hidden", [narrow]: "auto" },
		overflowY: { default: "auto", [narrow]: "hidden" },
		overscrollBehavior: "contain",
		scrollbarWidth: "thin",
		padding: {
			default: `${space.s5} ${space.s2} ${space.s3}`,
			[narrow]: `${space.s2} var(--page-padding)`,
		},
		backgroundColor: colors.page,
		borderRightWidth: { default: 1, [narrow]: 0 },
		borderBottomWidth: { default: 0, [narrow]: 1 },
		borderStyle: "solid",
		borderColor: colors.line,
		borderTopWidth: 0,
		borderLeftWidth: 0,
	},
	group: {
		display: { default: "grid", [narrow]: "contents" },
		gap: space.s0_5,
	},
	groupLabel: {
		display: { default: "block", [narrow]: "none" },
		margin: 0,
		paddingInline: space.s2,
		paddingBottom: space.s1,
		color: colors.muted,
		fontSize: typeScale.size12,
		lineHeight: typeScale.leading12,
		fontWeight: 500,
	},
	item: {
		display: "flex",
		alignItems: "center",
		flexShrink: 0,
		// The phone tab row keeps 44px targets for every pointer.
		minHeight: { default: size.control, [narrow]: 44 },
		paddingBlock: space.s1,
		paddingInline: { default: space.s2, [narrow]: space.s3 },
		borderRadius: geometry.corner,
		color: colors.muted,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		textDecoration: "none",
		whiteSpace: "nowrap",
		outline: "none",
		transitionProperty: {
			default: "background-color, color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	// The main sidebar's selection: an action tint, not a lifted chip.
	itemSelected: {
		color: colors.action,
		backgroundColor: {
			default: colors.actionSoft,
			":hover": colors.actionSoft,
			":focus-visible": colors.actionSoft,
		},
		fontWeight: 500,
	},
	content: {
		overflowX: "clip",
		minWidth: 0,
		// Same as the dashboard content; the page bar pulls itself up over the top padding.
		padding: "var(--page-padding)",
	},
});
