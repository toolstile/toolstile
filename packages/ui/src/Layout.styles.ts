import * as stylex from "@stylexjs/stylex";
import {
	colors,
	elevation,
	geometry,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

const mobile = "@media (max-width: 760px)";
const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const shimmer = stylex.keyframes({
	from: { backgroundPosition: "100% 0" },
	to: { backgroundPosition: "-100% 0" },
});

/** Common section layout and typography used by the UI primitives. */
export const layout = stylex.create({
	visuallyHidden: {
		position: "absolute",
		width: 1,
		height: 1,
		margin: 0,
		overflow: "hidden",
		clipPath: "inset(50%)",
		whiteSpace: "nowrap",
	},
	stack: {
		display: "flex",
		flexDirection: "column",
		gap: space.s4,
		minWidth: 0,
		fontFamily: geometry.fontSans,
	},
	/**
	 * Elevated container for selectable tiles and framed record collections only. Never nest it
	 * inside another card, dialog or list; group content within it by spacing and hairlines.
	 */
	card: {
		backgroundColor: colors.surface,
		color: colors.text,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
		padding: { default: space.s4, "@media (max-width: 600px)": space.s3 },
		minWidth: 0,
	},
	actions: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		flexWrap: "wrap",
	},
	heading: {
		fontSize: text.sectionTitle,
		lineHeight: text.sectionTitleLeading,
		fontWeight: 600,
		margin: 0,
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minWidth: 0,
		overflowWrap: "anywhere",
	},
	muted: {
		color: colors.muted,
		margin: 0,
		overflowWrap: "anywhere",
		maxWidth: "75ch",
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	meta: {
		color: colors.muted,
		margin: 0,
		fontSize: typeScale.size13,
		lineHeight: typeScale.leading13,
	},
	numeric: { fontVariantNumeric: "tabular-nums" },
	/** Flat page section (`Section`): no background, shadow or padding. */
	section: {
		display: "flex",
		flexDirection: "column",
		gap: space.s3,
		minWidth: 0,
		fontFamily: geometry.fontSans,
	},
	/** Hairline above a `Section` that follows a related one. */
	sectionDivided: {
		paddingTop: space.s6,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: colors.line,
	},
	/** Vertical rhythm between consecutive sections. */
	sections: {
		display: "flex",
		flexDirection: "column",
		gap: space.s8,
		minWidth: 0,
	},
	sectionHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s4,
		flexWrap: "wrap",
		minWidth: 0,
	},
	sectionHeading: {
		display: "flex",
		flexDirection: "column",
		gap: space.s0_5,
		flex: "1 1 240px",
		minWidth: 0,
	},
	sectionTitle: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		margin: 0,
		minWidth: 0,
		fontSize: text.sectionTitle,
		lineHeight: text.sectionTitleLeading,
		fontWeight: 600,
		overflowWrap: "anywhere",
	},
	sectionIcon: { display: "inline-flex", color: colors.action, flexShrink: 0 },
	/** One-line muted description under page and section titles. */
	description: {
		margin: 0,
		maxWidth: "75ch",
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		overflowWrap: "anywhere",
	},
	// The page bar: pinned to the top of the page, its fill and hairline reach both edges of
	// the page column (the column clips them), so it reads as the window's title bar.
	pageHeader: {
		// Phones keep the bar in the flow; pinned, it would take a fifth of the screen.
		position: { default: "sticky", [mobile]: "relative" },
		top: 0,
		zIndex: 5,
		isolation: "isolate",
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: space.s3,
		boxSizing: "border-box",
		minHeight: 56,
		// In fixed-height pages (Access) the content scrolls; the bar never gives up height.
		flexShrink: 0,
		marginTop: "calc(-1 * var(--page-padding))",
		// 24px from the subtitle to the first content on every page.
		marginBottom: space.s4,
		paddingTop: 24,
		paddingBottom: 8,
		minWidth: 0,
		"::before": {
			content: '""',
			position: "absolute",
			inset: "0 -100vw",
			zIndex: -1,
			backgroundColor: colors.page,
		},
	},
	stats: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
		margin: 0,
		marginBottom: space.s4,
		borderRadius: geometry.corner,
		backgroundColor: colors.surface,
		boxShadow: elevation.low,
		overflow: "hidden",
	},
	stat: {
		display: "grid",
		gap: 2,
		paddingBlock: 10,
		paddingInline: space.s3,
		minWidth: 0,
		// Hairlines between tiles; wrapped rows lose the leading one through the clip.
		boxShadow: `-1px 0 0 ${colors.line}`,
	},
	statLabel: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	},
	statValue: {
		display: "flex",
		alignItems: "baseline",
		gap: space.s2,
		margin: 0,
		fontSize: text.pageTitle,
		lineHeight: text.pageTitleLeading,
		fontWeight: 600,
		fontVariantNumeric: "tabular-nums",
	},
	statDetail: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 400,
	},
	pageBarTitle: {
		margin: 0,
		fontSize: text.pageTitle,
		lineHeight: text.pageTitleLeading,
		fontWeight: 600,
		letterSpacing: typeScale.trackingTight,
		overflowWrap: "anywhere",
	},
	pageBarDescription: {
		margin: 0,
		maxWidth: "75ch",
		marginTop: 2,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		overflowWrap: "anywhere",
	},
	pageHeaderRow: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s4,
		flexWrap: "wrap",
		minWidth: 0,
	},
	pageHeaderText: {
		display: "flex",
		flexDirection: "column",
		gap: 0,
		flex: "1 1 280px",
		minWidth: 0,
	},
	pageTitle: {
		margin: 0,
		fontSize: text.pageTitle,
		lineHeight: text.pageTitleLeading,
		fontWeight: 600,
		letterSpacing: typeScale.trackingTight,
		overflowWrap: "anywhere",
	},
	/** Flat empty state (`EmptyState`). */
	empty: {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		gap: space.s3,
		padding: `${space.s8} ${space.s4}`,
		textAlign: "center",
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	emptyIcon: {
		width: size.mark,
		height: size.mark,
		display: "grid",
		placeItems: "center",
		borderRadius: geometry.corner,
		backgroundColor: colors.actionSoft,
		color: colors.action,
	},
	emptyTitle: {
		margin: 0,
		fontSize: text.sectionTitle,
		lineHeight: text.sectionTitleLeading,
		fontWeight: 600,
	},
	emptyText: {
		margin: 0,
		maxWidth: "56ch",
		color: colors.muted,
		overflowWrap: "anywhere",
	},
	/** The one elevated container for a record collection; rows carry their own padding. */
	list: {
		backgroundColor: colors.surface,
		color: colors.text,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
		padding: 0,
		margin: 0,
		listStyle: "none",
		minWidth: 0,
	},
	/** Single-line row with a hairline between rows; add `listRowInteractive` for hover. */
	listRow: {
		display: "flex",
		alignItems: "center",
		gap: space.s3,
		minHeight: size.row,
		minWidth: 0,
		padding: {
			default: `${space.s2} ${space.s4}`,
			[mobile]: `${space.s2} ${space.s3}`,
		},
		borderBottomWidth: { default: 1, ":last-child": 0 },
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		borderTopLeftRadius: { default: 0, ":first-child": geometry.corner },
		borderTopRightRadius: { default: 0, ":first-child": geometry.corner },
		borderBottomLeftRadius: { default: 0, ":last-child": geometry.corner },
		borderBottomRightRadius: { default: 0, ":last-child": geometry.corner },
	},
	listRowInteractive: {
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
	},
	/** Lets a row's trailing actions drop below its text on narrow screens. */
	listRowWrap: { flexWrap: "wrap" },
	/** A row's title with muted lines stacked beneath; it takes the free width. */
	listRowDetail: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		flex: "1 1 180px",
		minWidth: 0,
		overflowWrap: "anywhere",
	},
	/** Title and muted detail on one line; the detail truncates first. */
	listRowInline: {
		display: "flex",
		alignItems: "baseline",
		gap: space.s2,
		flex: "1 1 240px",
		minWidth: 0,
	},
	/** Actions at the end of a row. */
	listRowTrailing: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: space.s2,
		marginInlineStart: "auto",
	},
	truncate: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	/** Placeholder bar while content loads; size it with width and height. */
	skeleton: {
		display: "block",
		borderRadius: geometry.corner,
		backgroundColor: colors.lineTint,
		// A lighter surface wash sweeping across the base tint.
		backgroundImage: `linear-gradient(90deg, transparent 0%, color-mix(in srgb, ${colors.surface} 70%, transparent) 50%, transparent 100%)`,
		backgroundSize: "200% 100%",
		backgroundRepeat: "no-repeat",
		animationName: { default: shimmer, [reducedMotion]: "none" },
		animationDuration: "1.4s",
		animationTimingFunction: "linear",
		animationIterationCount: "infinite",
		"@media (forced-colors: active)": {
			backgroundColor: "GrayText",
			backgroundImage: "none",
		},
	},
	/** Group label inside a list, such as a device above its agents. */
	listGroupHeader: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minHeight: 36,
		minWidth: 0,
		paddingInline: { default: space.s4, [mobile]: space.s3 },
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		color: colors.muted,
		fontSize: typeScale.size13,
		lineHeight: typeScale.leading13,
		fontWeight: 600,
	},
});
