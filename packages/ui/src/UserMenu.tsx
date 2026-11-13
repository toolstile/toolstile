import { Menu } from "@base-ui/react/menu";
import {
	ArrowUpRightIcon,
	BookOpenTextIcon,
	CaretUpDownIcon,
	CircleHalfIcon,
	GearSixIcon,
	LifebuoyIcon,
	SignOutIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useContext, useSyncExternalStore } from "react";
import { popupClassName, popupStyles } from "./Popup.styles";
import { SidebarCompact } from "./SidebarMode";
import { ThemeSwitcher } from "./ThemeSwitcher";
import {
	colors,
	elevation,
	geometry,
	size,
	space,
	text,
} from "./tokens.stylex";

const mobileQuery = "(max-width: 760px)";
function subscribeMobile(change: () => void) {
	const query = matchMedia(mobileQuery);
	query.addEventListener("change", change);
	return () => query.removeEventListener("change", change);
}
/** Settings, Docs and Help live in the sidebar's bottom row on wide screens and also sit in this menu on mobile. */
function useMobile() {
	return useSyncExternalStore(
		subscribeMobile,
		() => matchMedia(mobileQuery).matches,
		() => false,
	);
}

/** One rhythm for every row: 32px (44px on touch and phones), 13/20 text, 16px leading slot. */
const rowClass = (state: { highlighted: boolean }) =>
	stylex.props(styles.item, state.highlighted && styles.highlighted).className;

/** The 16px leading slot; Phosphor icons in it are muted. */
function Slot({ children }: { children: ReactNode }) {
	return (
		<span aria-hidden="true" {...stylex.props(styles.slot)}>
			{children}
		</span>
	);
}

/** "Theme" label with the shared segment inline, so a choice is one click and the menu stays open. */
function ThemeRow() {
	return (
		<Menu.Group {...stylex.props(styles.themeRow)}>
			<Slot>
				<CircleHalfIcon size={16} />
			</Slot>
			<Menu.GroupLabel {...stylex.props(styles.themeLabel)}>
				Theme
			</Menu.GroupLabel>
			<ThemeSwitcher menu />
		</Menu.Group>
	);
}

/** Action row with an optional leading icon in the 16px slot. */
export function MenuItem({
	icon,
	onClick,
	children,
}: {
	icon?: ReactNode;
	onClick(): void;
	children: ReactNode;
}) {
	return (
		<Menu.Item onClick={onClick} className={rowClass}>
			{icon ? <Slot>{icon}</Slot> : null}
			{children}
		</Menu.Item>
	);
}

/** Link row; `external` opens a new tab and adds the outbound arrow. */
export function MenuLinkItem({
	href,
	icon,
	external = false,
	children,
}: {
	href: string;
	icon?: ReactNode;
	external?: boolean;
	children: ReactNode;
}) {
	return (
		<Menu.LinkItem
			href={href}
			target={external ? "_blank" : undefined}
			rel={external ? "noreferrer" : undefined}
			closeOnClick
			className={rowClass}
		>
			{icon ? <Slot>{icon}</Slot> : null}
			{children}
			{external ? (
				<ArrowUpRightIcon
					size={14}
					aria-hidden="true"
					{...stylex.props(styles.trailing)}
				/>
			) : null}
		</Menu.LinkItem>
	);
}

/** A person's initial in a tinted tile, as on the account button. */
export function Avatar({ name, large }: { name: string; large?: boolean }) {
	return (
		<span
			aria-hidden="true"
			{...stylex.props(styles.avatar, large && styles.avatarLarge)}
		>
			{name.trim().slice(0, 1).toUpperCase()}
		</span>
	);
}

/** The hairline between account menu groups. */
export function MenuSeparator() {
	return <Menu.Separator {...stylex.props(styles.separator)} />;
}

/** What the dashboard hands its account menu: identity, links and the guarded actions. */
export interface AccountMenuProps {
	name: string;
	email: string;
	links?: { docs?: string; help?: string };
	/** Opens settings from the phone menu; wide screens use the sidebar's Settings button. */
	onSettings(): void;
	onSignOut(): void;
}

/**
 * Account button under the sidebar brand and its menu: the profile header and a separator, then `children`
 * (end them with `AccountMenuActions`). On phones the button collapses to the avatar tile.
 */
export function AccountMenu({
	name,
	email,
	subtitle = email,
	children,
}: {
	name: string;
	email: string;
	/** Second line under the name on the button. */
	subtitle?: string;
	children: ReactNode;
}) {
	const mobile = useMobile();
	// The compact rail shows only the avatar and opens the menu beside it.
	const compact = useContext(SidebarCompact) && !mobile;
	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label={`Account menu for ${name}`}
				title={`${name}\n${subtitle}`}
				className={(state) =>
					stylex.props(
						styles.trigger,
						compact && styles.triggerCompact,
						state.open && styles.triggerOpen,
					).className
				}
			>
				<Avatar name={name.trim() || email} />
				<span {...stylex.props(styles.identity, compact && styles.hidden)}>
					<span {...stylex.props(styles.name, styles.truncate)}>{name}</span>
					<span {...stylex.props(styles.email, styles.truncate)}>
						{subtitle}
					</span>
				</span>
				<CaretUpDownIcon
					size={16}
					aria-hidden="true"
					{...stylex.props(styles.caret, compact && styles.hidden)}
				/>
			</Menu.Trigger>
			<Menu.Portal>
				{/* Aligned to the trigger, whose box is the sidebar's 12px inset. */}
				<Menu.Positioner
					side={compact ? "right" : "bottom"}
					align={mobile ? "end" : "start"}
					sideOffset={6}
					collisionPadding={8}
					{...stylex.props(popupStyles.positioner)}
				>
					<Menu.Popup className={popupClassName(styles.popup)}>
						<Menu.Group>
							<Menu.GroupLabel {...stylex.props(styles.profile)}>
								<Avatar name={name.trim() || email} large />
								<span {...stylex.props(styles.profileText)}>
									<span {...stylex.props(styles.name, styles.truncate)}>
										{name}
									</span>
									<span
										title={email}
										{...stylex.props(styles.email, styles.truncate)}
									>
										{email}
									</span>
								</span>
							</Menu.GroupLabel>
						</Menu.Group>
						<MenuSeparator />
						{children}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

/** The account menu's closing rows: theme, sign-out, plus Settings, Docs and Help on phones. */
export function AccountMenuActions({
	links,
	onSettings,
	onSignOut,
}: Pick<AccountMenuProps, "links" | "onSettings" | "onSignOut">) {
	const mobile = useMobile();
	return (
		<>
			<Menu.Group>
				<ThemeRow />
				{mobile ? (
					<MenuItem icon={<GearSixIcon size={16} />} onClick={onSettings}>
						Settings
					</MenuItem>
				) : null}
				{mobile && links?.docs ? (
					<MenuLinkItem
						href={links.docs}
						external
						icon={<BookOpenTextIcon size={16} />}
					>
						Docs
					</MenuLinkItem>
				) : null}
				{mobile && links?.help ? (
					<MenuLinkItem
						href={links.help}
						external
						icon={<LifebuoyIcon size={16} />}
					>
						Help
					</MenuLinkItem>
				) : null}
			</Menu.Group>
			<MenuSeparator />
			<MenuItem icon={<SignOutIcon size={16} />} onClick={onSignOut}>
				Sign out
			</MenuItem>
		</>
	);
}

/** The standard account menu: profile header, then the closing rows. */
export function UserMenu({
	links,
	onSettings,
	onSignOut,
	...identity
}: AccountMenuProps) {
	return (
		<AccountMenu {...identity}>
			<AccountMenuActions
				links={links}
				onSettings={onSettings}
				onSignOut={onSignOut}
			/>
		</AccountMenu>
	);
}

const mobile = "@media (max-width: 760px)";

const styles = stylex.create({
	// A quiet row like the navigation items: no border, a hover fill; the avatar tile on phones.
	trigger: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		width: { default: "100%", [mobile]: "auto" },
		minWidth: 44,
		minHeight: { default: 40, [mobile]: 44 },
		padding: { default: `${space.s1} ${space.s2}`, [mobile]: space.s1 },
		borderWidth: 0,
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		color: colors.text,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: text.metaLeading,
		textAlign: "start",
		cursor: "pointer",
		outline: "none",
	},
	triggerOpen: { backgroundColor: colors.hoverOverlay },
	// The rail's avatar: a 32px cell, so it keeps the same 12px rhythm as the toggle and icons.
	triggerCompact: {
		width: 40,
		minWidth: 40,
		minHeight: 32,
		paddingBlock: 4,
		justifyContent: "center",
		paddingInline: 0,
	},
	hidden: { display: "none" },
	avatar: {
		width: { default: size.markSm, [mobile]: size.mark },
		height: { default: size.markSm, [mobile]: size.mark },
		display: "grid",
		placeItems: "center",
		backgroundColor: colors.actionSoft,
		// The tile edge shared with the workspace marks.
		boxShadow: elevation.tileRing,
		color: colors.action,
		borderRadius: geometry.corner,
		fontSize: { default: text.meta, [mobile]: text.body },
		fontWeight: 600,
		flexShrink: 0,
	},
	// The menu header's tile beside two text lines: 32px, with the trigger tile's half-height glyph.
	avatarLarge: {
		width: size.mark,
		height: size.mark,
		fontSize: text.dialogTitle,
	},
	identity: {
		display: { default: "grid", [mobile]: "none" },
		flex: 1,
		minWidth: 0,
	},
	truncate: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	name: { fontWeight: 500, color: colors.text },
	email: {
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		color: colors.muted,
	},
	caret: {
		display: { default: "block", [mobile]: "none" },
		flexShrink: 0,
		color: colors.muted,
	},
	popup: {
		width: "max(var(--anchor-width), 248px)",
		maxWidth: "min(300px, var(--available-width))",
		maxHeight: "var(--available-height)",
		overflowY: "auto",
		padding: space.s1,
		backgroundColor: colors.popover,
		color: colors.text,
		borderRadius: geometry.corner,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		// The popover plane: the hairline ring and menu shadow, never a heavier border.
		boxShadow: elevation.medium,
		outline: "none",
	},
	// A row in the item rhythm whose label is static; only the segments are interactive.
	themeRow: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minHeight: { default: size.control, [mobile]: 44 },
		paddingInline: space.s2,
		// The segment ends on the rows' 4px inset, like every right-aligned control here.
		paddingInlineEnd: 0,
	},
	themeLabel: { flex: 1, fontSize: text.body, lineHeight: text.bodyLeading },
	profile: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		padding: `${space.s1} ${space.s2}`,
	},
	profileText: { display: "grid", flex: 1, minWidth: 0 },
	item: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minHeight: { default: size.control, [mobile]: 44 },
		paddingBlock: 0,
		paddingInline: space.s2,
		borderRadius: geometry.corner,
		cursor: "pointer",
		userSelect: "none",
		outline: "none",
		color: "inherit",
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		textDecoration: "none",
	},
	highlighted: {
		backgroundColor: colors.hoverOverlay,
		boxShadow: elevation.itemRing,
	},
	slot: {
		display: "grid",
		placeItems: "center",
		width: size.icon,
		height: size.icon,
		flexShrink: 0,
		color: colors.muted,
	},
	trailing: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s1,
		marginLeft: "auto",
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 400,
	},
	// Lighter than the row hairline: inside the popover it only groups, never boxes.
	separator: {
		height: 1,
		marginBlock: space.s1,
		backgroundColor: `color-mix(in srgb, ${colors.line} 55%, transparent)`,
	},
});
