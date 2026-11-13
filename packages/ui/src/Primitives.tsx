import {
	CheckCircleIcon,
	type Icon,
	InfoIcon,
	WarningCircleIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { controls } from "./Control.styles";
import { formatFullDate, formatRelative } from "./format";
import { layout } from "./Layout.styles";
import {
	colors,
	geometry,
	motion,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

/** Relative time with the exact local date and time on hover; `compact` reads "4m ago". */
export function RelativeTime({
	value,
	compact = false,
}: {
	value: string | Date;
	compact?: boolean;
}) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return <span>—</span>;
	return (
		<time
			dateTime={date.toISOString()}
			title={formatFullDate(date)}
			{...stylex.props(layout.numeric)}
		>
			{formatRelative(date, Date.now(), { compact })}
		</time>
	);
}

export type NoticeTone = "info" | "warning" | "error" | "success";

const noticeIcons: Record<NoticeTone, Icon> = {
	info: InfoIcon,
	warning: WarningIcon,
	error: WarningCircleIcon,
	success: CheckCircleIcon,
};

/**
 * Inline status (`role="status"`) or error (`role="alert"`) message: a flat tinted strip with an
 * icon, for pages and inside surfaces. `tone` defaults to `info`, or `error` when `error` is set.
 */
export function Notice({
	children,
	error = false,
	tone = error ? "error" : "info",
}: {
	children: ReactNode;
	error?: boolean;
	tone?: NoticeTone;
}) {
	const ToneIcon = noticeIcons[tone];
	return (
		<div
			{...stylex.props(styles.notice, noticeTones[tone])}
			role={tone === "error" ? "alert" : "status"}
		>
			<ToneIcon
				size={16}
				aria-hidden="true"
				{...stylex.props(styles.noticeIcon, noticeIconTones[tone])}
			/>
			<div {...stylex.props(styles.noticeBody)}>{children}</div>
		</div>
	);
}

/**
 * Flat page section: a 14px heading, optional muted one-liner and header action, then content
 * 12px below. Stack sections in `layout.sections`; `divided` adds a hairline above.
 */
export function Section({
	title,
	icon,
	description,
	action,
	divided = false,
	children,
}: {
	title: ReactNode;
	icon?: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	divided?: boolean;
	children?: ReactNode;
}) {
	return (
		<section
			{...stylex.props(layout.section, divided && layout.sectionDivided)}
		>
			<div {...stylex.props(layout.sectionHeader)}>
				<div {...stylex.props(layout.sectionHeading)}>
					<h2 {...stylex.props(layout.sectionTitle)}>
						{icon && <span {...stylex.props(layout.sectionIcon)}>{icon}</span>}
						{title}
					</h2>
					{description && (
						<p {...stylex.props(layout.description)}>{description}</p>
					)}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

/** Page title with an optional description and right-aligned actions; tabs go in `children`. */
export function PageHeader({
	title,
	description,
	actions,
	children,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
}) {
	// Publishes the pinned bar's height as --page-header-height, so content pinned beneath it
	// (the catalog toolbar) follows the header whatever its title, description or tabs.
	const header = useRef<HTMLElement>(null);
	useLayoutEffect(() => {
		const element = header.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const root = document.documentElement;
		const publish = () =>
			root.style.setProperty(
				"--page-header-height",
				`${Math.round(element.getBoundingClientRect().height)}px`,
			);
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(element);
		return () => {
			observer.disconnect();
			root.style.removeProperty("--page-header-height");
		};
	}, []);
	return (
		<header ref={header} {...stylex.props(layout.pageHeader)}>
			<div {...stylex.props(layout.pageHeaderRow)}>
				<div {...stylex.props(layout.pageHeaderText)}>
					<h1 {...stylex.props(layout.pageBarTitle)}>{title}</h1>
					{description && (
						<p {...stylex.props(layout.pageBarDescription)}>{description}</p>
					)}
				</div>
				{actions && <div {...stylex.props(layout.actions)}>{actions}</div>}
			</div>
			{children}
		</header>
	);
}

/** A row of figures in one framed strip, such as an activity or usage summary. */
export function StatStrip({
	label,
	items,
}: {
	/** Names the group for assistive technology. */
	label: string;
	items: { label: string; value: ReactNode; detail?: ReactNode }[];
}) {
	return (
		<dl aria-label={label} {...stylex.props(layout.stats)}>
			{items.map((item) => (
				<div key={item.label} {...stylex.props(layout.stat)}>
					<dt {...stylex.props(layout.statLabel)}>{item.label}</dt>
					<dd {...stylex.props(layout.statValue)}>
						{item.value}
						{item.detail ? (
							<span {...stylex.props(layout.statDetail)}>{item.detail}</span>
						) : null}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** Flat empty state: an icon in a soft tile, optional title, one sentence and one action. */
export function EmptyState({
	icon: StateIcon,
	title,
	children,
	action,
}: {
	icon?: Icon;
	title?: ReactNode;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div {...stylex.props(layout.empty)}>
			{StateIcon && (
				<span {...stylex.props(layout.emptyIcon)}>
					<StateIcon size={20} aria-hidden="true" />
				</span>
			)}
			{title && <h2 {...stylex.props(layout.emptyTitle)}>{title}</h2>}
			{children && <p {...stylex.props(layout.emptyText)}>{children}</p>}
			{action}
		</div>
	);
}

/** @deprecated Use `Section`; `Panel` renders the same flat section. */
export function Panel({
	title,
	icon,
	description,
	action,
	children,
}: {
	title: string;
	icon?: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Section
			title={title}
			icon={icon}
			description={description}
			action={action}
		>
			{children}
		</Section>
	);
}

/** Underlined tab row; the caller keeps the selected tab in validated URL state. */
export function Tabs<T extends string>({
	value,
	items,
	onChange,
	label,
}: {
	value: T;
	/** `count` adds a small tally after the label, such as waiting requests. */
	items: { id: T; label: string; count?: number }[];
	onChange: (id: T) => void;
	label: string;
}) {
	return (
		<nav aria-label={label} {...stylex.props(styles.tabs)}>
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					aria-current={value === item.id ? "page" : undefined}
					{...stylex.props(styles.tab, value === item.id && styles.tabSelected)}
					onClick={() => onChange(item.id)}
				>
					{item.label}
					{item.count ? (
						<span
							{...stylex.props(
								styles.tabCount,
								value === item.id && styles.tabCountSelected,
							)}
						>
							{item.count.toLocaleString()}
						</span>
					) : null}
				</button>
			))}
		</nav>
	);
}

/** Previous/next pager with a result count; hidden when everything fits on one page. */
export function Pagination({
	page,
	total,
	onChange,
	size = 10,
}: {
	page: number;
	total: number;
	size?: number;
	onChange(page: number): void;
}) {
	const pages = Math.max(1, Math.ceil(total / size));
	return total > size ? (
		<nav aria-label="Pagination" {...stylex.props(styles.pagination)}>
			<p {...stylex.props(layout.meta, layout.numeric)}>
				Page {page} of {pages} · {total.toLocaleString()} results
			</p>
			<div {...stylex.props(layout.actions)}>
				<button
					type="button"
					{...stylex.props(controls.button, controls.quiet, controls.small)}
					disabled={page <= 1}
					onClick={() => onChange(page - 1)}
				>
					Previous
				</button>
				<button
					type="button"
					{...stylex.props(controls.button, controls.quiet, controls.small)}
					disabled={page >= pages}
					onClick={() => onChange(page + 1)}
				>
					Next
				</button>
			</div>
		</nav>
	) : null;
}

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
	notice: {
		display: "flex",
		alignItems: "flex-start",
		gap: space.s2,
		padding: `${space.s2} ${space.s3}`,
		color: colors.text,
		borderRadius: geometry.corner,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		overflowWrap: "anywhere",
	},
	noticeIcon: {
		flexShrink: 0,
		width: size.icon,
		height: size.icon,
		marginTop: 1,
	},
	noticeBody: { flex: 1, minWidth: 0 },
	// The hairline is an inset shadow, not a border, so the tabs fill the strip's full height:
	// a border would leave them 1px taller than the scroll box and show a vertical scrollbar.
	// A strip too wide for a phone still scrolls sideways, without a visible bar.
	tabs: {
		display: "flex",
		alignItems: "stretch",
		gap: space.s1,
		overflowX: "auto",
		overflowY: "hidden",
		scrollbarWidth: "none",
		boxShadow: `inset 0 -1px 0 ${colors.line}`,
	},
	tab: {
		display: "inline-flex",
		alignItems: "center",
		flexShrink: 0,
		minHeight: size.tab,
		paddingInline: 10,
		borderWidth: 0,
		borderBottomWidth: 2,
		borderBottomStyle: "solid",
		borderBottomColor: "transparent",
		borderRadius: `${geometry.corner} ${geometry.corner} 0 0`,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 400,
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap",
		cursor: "pointer",
		outlineOffset: -3,
		transitionProperty: {
			default: "color, background-color, border-color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	tabSelected: {
		color: {
			default: colors.text,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		borderBottomColor: colors.action,
		fontWeight: 500,
	},
	tabCount: {
		display: "inline-grid",
		placeItems: "center",
		minWidth: 18,
		height: 18,
		marginInlineStart: 6,
		paddingInline: 5,
		borderRadius: geometry.cornerSmall,
		backgroundColor: colors.lineTint,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: 1,
		fontWeight: 500,
	},
	tabCountSelected: {
		backgroundColor: colors.actionTint,
		color: colors.action,
	},
	pagination: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s3,
		flexWrap: "wrap",
	},
});

const noticeTones = stylex.create({
	info: { backgroundColor: colors.actionTint },
	warning: { backgroundColor: colors.warningTint },
	error: { backgroundColor: colors.badTint },
	success: { backgroundColor: colors.goodTint },
});

const noticeIconTones = stylex.create({
	info: { color: colors.action },
	warning: { color: colors.warning },
	error: { color: colors.bad },
	success: { color: colors.good },
});
