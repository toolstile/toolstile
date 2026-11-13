import {
	ArrowUpRightIcon,
	BookOpenTextIcon,
	CaretRightIcon,
	ClockCounterClockwiseIcon,
	DesktopTowerIcon,
	GearSixIcon,
	type Icon,
	LifebuoyIcon,
	PlugsConnectedIcon,
	ShieldCheckIcon,
	SquaresFourIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { AccessSearch } from "@toolstile/api/contract";
import type { ReactNode, Ref } from "react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { dashboardStyles as styles } from "./Dashboard.styles";
import { SidebarCompact } from "./SidebarMode";
import { Tooltip } from "./Tooltip";
import { colors, motion } from "./tokens.stylex";

const phone = "(max-width: 760px)";

/** A sidebar group; `items` reference navigation ids (built-in sections and `extraNavigation`). */
export interface DashboardNavigationGroup {
	id: string;
	label: string;
	items: string[];
}
export const defaultNavigationGroups: DashboardNavigationGroup[] = [
	{
		id: "gateway",
		label: "Gateway",
		items: ["connections", "devices", "access", "activity"],
	},
];
export type NavigationEntry = {
	id: string;
	label: string;
	icon: Icon;
	hidden?: boolean;
	/** Waiting work in this section (pending approvals, changes to review); shown when > 0. */
	count?: number;
};
/** An app-owned section; `description` is the one-line subheading under the page title. */
export interface ExtraNavigationItem {
	id: string;
	label: string;
	icon?: Icon;
	description?: string;
	/**
	 * Keeps the page, its title and description but leaves it out of the sidebar list, for a
	 * section the app links from `sidebarTrailing` instead.
	 */
	hidden?: boolean;
	/** Waiting work in this section, from `useNavigationCounts`; shown when > 0. */
	count?: number;
}

export interface DashboardLinks {
	docs?: string;
	help?: string;
}
export const defaultDashboardLinks = {
	docs: "https://github.com/toolstile/toolstile#readme",
	help: "mailto:support@toolstile.com",
} satisfies Required<DashboardLinks>;

/** A click the dashboard may cancel, such as leaving a page with unsaved edits. */
type NavigationClick = { preventDefault(): void };
/** Props for one sidebar link, rendered by the app's router link. */
export interface DashboardNavigationItem {
	id: string;
	className: string;
	children: ReactNode;
	onClick(event: NavigationClick): void;
	"aria-current"?: "page";
	"aria-label"?: string;
	title?: string;
}

/** Props for the app's router link (such as TanStack `Link`) in the sidebar and settings. */
export interface DashboardShellLink {
	to: string;
	/** Access page view; other pages leave it unset so their links clear it. */
	search?: AccessSearch;
	hash?: string;
	className: string;
	children: ReactNode;
	onClick(event: NavigationClick): void;
	"aria-current"?: "page";
	"aria-label"?: string;
	title?: string;
}
/** Route for a navigation id; unknown ids go to `/app/connections`. */
export const shellDestination = (
	destinations: Record<string, string>,
	id: string,
) => destinations[id] ?? "/app/connections";

/** Built-in sections, then the app's sections, then Settings (shown in the bottom links). */
export function navigationEntries(
	extraNavigation: ExtraNavigationItem[] = [],
): NavigationEntry[] {
	return [
		{ id: "connections", label: "MCP connections", icon: PlugsConnectedIcon },
		{ id: "devices", label: "Devices & agents", icon: DesktopTowerIcon },
		{ id: "access", label: "Access", icon: ShieldCheckIcon },
		{ id: "activity", label: "Activity", icon: ClockCounterClockwiseIcon },
		...extraNavigation.map((n) => ({ ...n, icon: n.icon ?? SquaresFourIcon })),
		{ id: "settings", label: "Settings", icon: GearSixIcon },
	];
}

/** Link props for a navigation entry; `count` adds the pill after the label. */
export function navigationItem({
	entry,
	section,
	count,
	onClick,
}: {
	entry: NavigationEntry;
	section: string;
	count?: number;
	onClick(event: NavigationClick): void;
}): DashboardNavigationItem {
	const selected = section === entry.id;
	return {
		id: entry.id,
		// The marker lets the rail tooltip react to hovering the whole item.
		className: [
			stylex.props(stylex.defaultMarker()).className,
			stylex.props(styles.navItem, selected && styles.navSelected).className,
		]
			.filter(Boolean)
			.join(" "),
		"aria-current": selected ? "page" : undefined,
		onClick,
		children: (
			<>
				<entry.icon
					size={16}
					weight={selected ? "fill" : "regular"}
					{...stylex.props(styles.navIcon, !selected && styles.navItemIcon)}
				/>
				<NavLabel label={entry.label} count={count} selected={selected} />
			</>
		),
	};
}

/**
 * A navigation item's label and count. The compact rail keeps the label as the link's name and
 * shows it as a tooltip beside the icon; the count becomes a small badge on the icon.
 */
function NavLabel({
	label,
	count,
	selected,
}: {
	label: string;
	count?: number;
	selected: boolean;
}) {
	const compact = useContext(SidebarCompact);
	if (compact)
		return (
			<>
				<span {...stylex.props(styles.navTooltip)}>
					{label}
					{count === undefined ? null : ` (${count})`}
				</span>
				{count ? (
					<span aria-hidden="true" {...stylex.props(styles.navCountDot)} />
				) : null}
			</>
		);
	return (
		<>
			{label}
			{count === undefined ? null : (
				<span
					{...stylex.props(
						styles.navCount,
						selected && styles.navCountSelected,
					)}
				>
					{count}
				</span>
			)}
		</>
	);
}

/**
 * Link props for a 32px icon-only sidebar button; the label is its accessible name and
 * tooltip. Apps may add to `children`, such as an unread dot.
 */
export function navigationIconItem({
	entry,
	section,
	label = entry.label,
	onClick,
}: {
	entry: NavigationEntry;
	section: string;
	/** Accessible name, such as the label with an unread count; defaults to the label. */
	label?: string;
	onClick(event: NavigationClick): void;
}): DashboardNavigationItem {
	const selected = section === entry.id;
	return {
		id: entry.id,
		className:
			stylex.props(
				styles.navIconButton,
				selected && styles.navIconButtonSelected,
			).className ?? "",
		"aria-current": selected ? "page" : undefined,
		"aria-label": label,
		onClick,
		children: (
			<entry.icon
				size={16}
				weight={selected ? "fill" : "regular"}
				aria-hidden="true"
				{...stylex.props(styles.navIcon)}
			/>
		),
	};
}

/** The grouped section links; Settings is left for `SidebarLinks`. */
export function MainNavigation({
	ref,
	scrollable = false,
	groups,
	entries,
	renderItem,
}: {
	ref?: Ref<HTMLElement>;
	/** Adds hairlines above and below when the list scrolls. */
	scrollable?: boolean;
	groups: DashboardNavigationGroup[];
	entries: NavigationEntry[];
	renderItem(entry: NavigationEntry): ReactNode;
}) {
	const compact = useContext(SidebarCompact);
	// The rail never scrolls, so it never needs the scroll hairlines.
	const hairlines = scrollable && !compact;
	const strip = usePhoneStrip();
	return (
		<nav
			ref={(element) => {
				strip.ref.current = element;
				if (typeof ref === "function") return ref(element);
				if (ref) ref.current = element;
			}}
			aria-label="Main navigation"
			data-toolstile-navigation
			data-scroll-restoration-id="dashboard-navigation"
			onScroll={strip.measure}
			{...stylex.props(
				styles.navigation,
				hairlines && styles.navigationScrollable,
				compact && styles.navigationCompact,
				strip.more && stripStyles.stripMore,
			)}
		>
			<NavigationGroups
				groups={groups}
				items={entries.filter(
					(entry) => entry.id !== "settings" && !entry.hidden,
				)}
				renderItem={renderItem}
			/>
			{strip.more ? (
				// Pointer shortcut only: keyboard users reach every section by Tab.
				<button
					type="button"
					tabIndex={-1}
					aria-hidden="true"
					onClick={strip.next}
					{...stylex.props(stripStyles.more)}
				>
					<CaretRightIcon size={14} weight="bold" />
				</button>
			) : null}
		</nav>
	);
}

/**
 * The phone tab strip: shows the current section once navigation settles, and a visible cue
 * while more sections sit past the right edge. Router scroll restoration carries the previous
 * page's strip offset over, so the reveal waits a frame and runs after it.
 */
function usePhoneStrip() {
	const ref = useRef<HTMLElement | null>(null);
	const revealed = useRef<Element | null>(null);
	const [more, setMore] = useState(false);
	const measure = useCallback(() => {
		const strip = ref.current;
		setMore(
			!!strip &&
				matchMedia(phone).matches &&
				strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2,
		);
	}, []);
	// Runs after every render, but reveals only when the current item changes, so it never
	// undoes a swipe.
	useEffect(() => {
		const strip = ref.current;
		const current = strip?.querySelector('[aria-current="page"]') ?? null;
		if (!strip || current === revealed.current) return;
		revealed.current = current;
		const frame = requestAnimationFrame(() => {
			if (current && matchMedia(phone).matches) {
				const item = current.getBoundingClientRect();
				const view = strip.getBoundingClientRect();
				// Keep clear of the edge fades and the cue.
				if (item.left < view.left + 12)
					strip.scrollLeft += item.left - view.left - 12;
				else if (item.right > view.right - 36)
					strip.scrollLeft += item.right - view.right + 36;
			}
			measure();
		});
		return () => cancelAnimationFrame(frame);
	});
	useEffect(() => {
		const strip = ref.current;
		if (!strip) return;
		const observer = new ResizeObserver(measure);
		observer.observe(strip);
		return () => observer.disconnect();
	}, [measure]);
	return {
		ref,
		more,
		measure,
		next: () =>
			ref.current?.scrollBy({
				left: ref.current.clientWidth * 0.7,
				behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
					? "auto"
					: "smooth",
			}),
	};
}

const stripStyles = stylex.create({
	// While the cue shows it replaces the trailing fade, which would otherwise hide it.
	stripMore: {
		maskImage: "linear-gradient(to right, transparent, #000 12px, #000 100%)",
	},
	// Pinned to the strip's right edge over a fade of the sidebar surface. Sticky offsets start
	// inside the strip's 24px end padding, so the cue pulls back out to the visible edge.
	more: {
		position: "sticky",
		right: -24,
		flexShrink: 0,
		display: "grid",
		placeItems: "center end",
		width: 40,
		minHeight: 44,
		// Takes no room in the row, so adding or removing it never shifts the tabs.
		marginInlineStart: -40,
		paddingInlineEnd: 6,
		borderWidth: 0,
		backgroundColor: "transparent",
		backgroundImage: `linear-gradient(to right, transparent, ${colors.sidebarSurface} 45%)`,
		color: colors.muted,
		cursor: "pointer",
		transitionProperty: "color",
		transitionDuration: motion.fast,
		":hover": { color: colors.text },
		":focus-visible": { color: colors.text },
	},
});

/**
 * The sidebar's last row of icon buttons: Settings, Docs and Help, then the app's `trailing`
 * buttons at the end. On phones Docs and Help move into the account menu.
 */
export function SidebarLinks({
	settings,
	links,
	trailing,
}: {
	/** The Settings link, built with `navigationIconItem`. */
	settings: ReactNode;
	links?: DashboardLinks;
	trailing?: ReactNode;
}) {
	const external = [
		{
			label: "Docs",
			href: links?.docs ?? defaultDashboardLinks.docs,
			icon: BookOpenTextIcon,
		},
		{
			label: "Help",
			href: links?.help ?? defaultDashboardLinks.help,
			icon: LifebuoyIcon,
		},
	];
	const compact = useContext(SidebarCompact);
	// Labels open above the bottom row, or beside the rail when it is compact.
	const side = compact ? "right" : "top";
	return (
		<nav
			aria-label="Settings and help"
			{...stylex.props(
				styles.sidebarLinks,
				compact && styles.sidebarLinksCompact,
			)}
		>
			<Tooltip label="Settings" side={side}>
				{settings}
			</Tooltip>
			{external.map(({ label, href, icon: LinkIcon }) => (
				<Tooltip
					key={label}
					side={side}
					anchorStyle={styles.sidebarExternalLink}
					label={
						<>
							{label}
							<ArrowUpRightIcon size={12} weight="bold" aria-hidden="true" />
						</>
					}
				>
					<a
						href={href}
						target="_blank"
						rel="noreferrer"
						aria-label={`${label} (opens in a new tab)`}
						{...stylex.props(styles.navIconButton)}
					>
						<LinkIcon
							size={16}
							aria-hidden="true"
							{...stylex.props(styles.navIcon)}
						/>
					</a>
				</Tooltip>
			))}
			<div
				{...stylex.props(
					styles.sidebarTrailing,
					compact && styles.sidebarTrailingCompact,
				)}
			>
				{trailing}
			</div>
		</nav>
	);
}

/** Grouped sidebar navigation under plain, always-visible group labels. */
export function NavigationGroups({
	groups,
	items,
	renderItem,
}: {
	groups: DashboardNavigationGroup[];
	items: NavigationEntry[];
	renderItem(entry: NavigationEntry): ReactNode;
}) {
	const compact = useContext(SidebarCompact);
	const byId = new Map(items.map((item) => [item.id, item]));
	const grouped = new Set(groups.flatMap((group) => group.items));
	const resolved = [
		...groups.map((group) => ({
			...group,
			entries: group.items.flatMap((id) => byId.get(id) ?? []),
		})),
		// Sections missing from every group still render, without a label.
		{
			id: "",
			label: "",
			items: [],
			entries: items.filter((item) => !grouped.has(item.id)),
		},
	].filter((group) => group.entries.length);
	return resolved.map((group, index) => {
		const entries = (
			<div {...stylex.props(styles.navGroupItems)}>
				{group.entries.map((entry) => renderItem(entry))}
			</div>
		);
		// A lone group needs no heading: the sidebar itself is the group.
		if (!group.label || resolved.length === 1)
			return (
				<div key="ungrouped" {...stylex.props(styles.navGroup)}>
					{entries}
				</div>
			);
		return (
			<div key={group.id} {...stylex.props(styles.navGroup)}>
				{/* The rail separates groups with a short rule instead of the label. */}
				{compact ? (
					index === 0 ? null : (
						<span role="presentation" {...stylex.props(styles.navGroupRule)} />
					)
				) : (
					<p {...stylex.props(styles.navGroupLabel)}>{group.label}</p>
				)}
				{entries}
			</div>
		);
	});
}
