import * as stylex from "@stylexjs/stylex";
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

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const mobile = "@media (max-width: 760px)";
const coarse = "@media (pointer: coarse)";
/** Connection rows stack when the list is narrower than its fixed columns need. */
const connectionStacked = "@container (max-width: 879px)";
const railWidth = "60px";

const dropIn = stylex.keyframes({
	from: { opacity: 0, transform: "translateY(-4px)" },
	to: { opacity: 1, transform: "none" },
});

export const dashboardStyles = stylex.create({
	layout: {
		display: { default: "grid", [mobile]: "block" },
		gridTemplateColumns: `${size.sidebar} minmax(0, 1fr)`,
		minHeight: "100dvh",
		transitionProperty: {
			default: "grid-template-columns",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.slow,
		transitionTimingFunction: motion.easeOut,
	},
	// The compact rail: 40px of icons inside 10px insets.
	layoutCompact: { gridTemplateColumns: `${railWidth} minmax(0, 1fr)` },
	sidebar: {
		position: { default: "sticky", [mobile]: "relative" },
		top: { default: 0, [mobile]: "auto" },
		height: { default: "100dvh", [mobile]: "auto" },
		minHeight: 0,
		alignSelf: "start",
		overflow: { default: "hidden", [mobile]: "visible" },
		backgroundColor: colors.sidebarSurface,
		borderRightWidth: { default: 1, [mobile]: 0 },
		borderRightStyle: "solid",
		borderRightColor: colors.line,
		borderBottomWidth: { default: 0, [mobile]: 1 },
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		// Equal outer insets keep the sidebar balanced at every viewport height.
		padding: space.s3,
		// Mobile: brand, setup pill and account share the first row; the tab strip ends with Settings.
		display: { default: "flex", [mobile]: "grid" },
		gridTemplateColumns: "minmax(0, 1fr) auto auto",
		alignItems: { default: "stretch", [mobile]: "center" },
		flexDirection: "column",
		gap: {
			default: space.s3,
			"@media (max-height: 600px)": space.s2,
			[mobile]: `${space.s3} ${space.s2}`,
		},
	},
	// The lockup is a link home; it keeps the mark's own colours and only shows a focus ring.
	brandLink: {
		display: "inline-flex",
		alignItems: "center",
		borderRadius: geometry.corner,
		outline: "none",
		backgroundColor: {
			default: "transparent",
			":focus-visible": colors.hoverOverlay,
		},
		textDecoration: "none",
	},
	// The brand row is as tall as the page header bar's content, so the lockup and the page
	// title share a centre line; the collapse toggle ends the row.
	brand: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		height: { default: 32, [mobile]: 24 },
		paddingInlineStart: { default: 12, [mobile]: 0 },
		flexShrink: 0,
		gridColumn: 1,
		gridRow: 1,
	},
	// The rail stacks the mark over the toggle, close together, as one block.
	brandCompact: {
		flexDirection: { default: "column", [mobile]: "row" },
		gap: { default: space.s3, [mobile]: space.s2 },
		height: { default: "auto", [mobile]: 24 },
		paddingInlineStart: 0,
		paddingTop: { default: 8, [mobile]: 0 },
	},
	sidebarToggle: {
		display: { default: "inline-flex", [mobile]: "none" },
		marginLeft: "auto",
	},
	toggleButton: { width: 28, height: 28 },
	sidebarToggleCompact: { marginLeft: 0 },
	sidebarCompact: {
		overflow: "visible",
		gap: { default: space.s2, [mobile]: `${space.s3} ${space.s2}` },
		paddingInline: { default: 10, [mobile]: space.s3 },
		alignItems: { default: "center", [mobile]: "center" },
	},
	sidebarAccountCompact: { justifySelf: "center" },
	sidebarBottomCompact: { alignItems: "center" },
	navigation: {
		display: { default: "grid", [mobile]: "flex" },
		gap: { default: space.s3, [mobile]: space.s1 },
		flex: { default: "1 1 auto", [mobile]: "none" },
		minHeight: 0,
		minWidth: 0,
		alignContent: "start",
		gridColumn: 1,
		overflowX: { default: "hidden", [mobile]: "auto" },
		overflowY: { default: "auto", [mobile]: "hidden" },
		overscrollBehavior: "contain",
		// Phones: swipes and the selected-tab reveal come to rest on a tab's left edge, so the
		// leading tab is not cut mid-word. Proximity, not mandatory: mandatory re-snaps to the
		// previous tab when the selection re-renders and undoes the reveal.
		scrollSnapType: { default: "none", [mobile]: "x proximity" },
		scrollPadding: { default: 6, [mobile]: "0 24px 0 12px" },
		// Phones: the strip reaches into the sidebar's 12px inset so tabs keep their position,
		// and both edges fade. The leading fade covers only that inset at rest, and fades a tab
		// cut at the end of the scroll range; the trailing fade marks more tabs to the right.
		margin: { default: -6, [mobile]: "0 0 0 -12px" },
		padding: { default: 6, [mobile]: "6px 24px 6px 12px" },
		maskImage: {
			default: "none",
			[mobile]:
				"linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 24px), transparent)",
		},
		scrollbarWidth: "thin",
	},
	navigationScrollable: {
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: colors.line,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	// Groups flatten into the mobile tab strip.
	navGroup: {
		display: { default: "grid", [mobile]: "contents" },
		gap: space.s0_5,
		alignContent: "start",
	},
	navGroupLabel: {
		display: { default: "block", [mobile]: "none" },
		margin: 0,
		paddingInline: 12,
		paddingBottom: 6,
		color: colors.muted,
		fontSize: 11,
		lineHeight: typeScale.leading12,
		fontWeight: 500,
		letterSpacing: "0.06em",
		textTransform: "uppercase",
		opacity: 0.85,
	},
	navGroupItems: {
		display: { default: "grid", [mobile]: "contents" },
		gap: space.s0_5,
	},
	navItem: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		justifyContent: "flex-start",
		position: "relative",
		borderWidth: 0,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		paddingBlock: { default: space.s1, [mobile]: space.s2 },
		paddingInline: space.s3,
		color: colors.text,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		textAlign: "left",
		textDecoration: "none",
		whiteSpace: "nowrap",
		borderRadius: geometry.corner,
		// The phone tab strip keeps 44px targets for every pointer.
		minHeight: { default: size.control, [mobile]: 44 },
		flexShrink: 0,
		scrollSnapAlign: { default: "none", [mobile]: "start" },
		transitionProperty: {
			default: "background-color, color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	navSelected: {
		backgroundColor: {
			default: colors.navSelected,
			":hover": colors.navSelected,
			":focus-visible": colors.navSelected,
		},
		color: colors.action,
		fontWeight: 500,
		// The fill alone marks the selection on wide screens; the phone tab strip adds a 2px
		// underline under the label.
		"::before": {
			content: { default: "none", [mobile]: '""' },
			position: "absolute",
			insetInlineStart: { default: 0, [mobile]: 12 },
			insetInlineEnd: { default: "auto", [mobile]: 12 },
			top: { default: 6, [mobile]: "auto" },
			bottom: { default: 6, [mobile]: 0 },
			width: { default: 2, [mobile]: "auto" },
			height: { default: "auto", [mobile]: 2 },
			borderRadius: 2,
			backgroundColor: colors.action,
			boxShadow: elevation.navIndicatorGlow,
		},
	},
	navIcon: { display: "block", flexShrink: 0 },
	// The rail's labels: a tooltip to the right of the icon on hover or keyboard focus.
	navTooltip: {
		position: "absolute",
		insetInlineStart: "calc(100% + 10px)",
		top: "50%",
		zIndex: 20,
		paddingBlock: 4,
		paddingInline: space.s2,
		borderRadius: geometry.cornerSmall,
		backgroundColor: colors.text,
		color: colors.page,
		boxShadow: elevation.medium,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		whiteSpace: "nowrap",
		pointerEvents: "none",
		opacity: {
			default: 0,
			[stylex.when.ancestor(":hover")]: 1,
			[stylex.when.ancestor(":focus-visible")]: 1,
		},
		transform: {
			default: "translate(-4px, -50%)",
			[stylex.when.ancestor(":hover")]: "translate(0, -50%)",
			[stylex.when.ancestor(":focus-visible")]: "translate(0, -50%)",
		},
		transitionProperty: {
			default: "opacity, transform",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.fast,
		transitionTimingFunction: motion.easeOut,
	},
	navCountDot: {
		position: "absolute",
		top: 6,
		insetInlineEnd: 6,
		width: 6,
		height: 6,
		borderRadius: 999,
		backgroundColor: colors.action,
		boxShadow: `0 0 0 2px ${colors.sidebarSurface}`,
	},
	navGroupRule: {
		display: { default: "block", [mobile]: "none" },
		height: 1,
		marginInline: 8,
		marginBottom: space.s1,
		backgroundColor: colors.line,
	},
	// The rail lets tooltips reach past its edge; its short icon list does not need to scroll.
	navigationCompact: {
		overflowX: { default: "visible", [mobile]: "auto" },
		overflowY: { default: "visible", [mobile]: "hidden" },
		gap: { default: space.s2, [mobile]: space.s1 },
	},
	// Unselected labels read at text colour; their icons stay muted under the group labels.
	navItemIcon: { color: colors.muted },
	navCount: {
		marginLeft: "auto",
		display: "inline-grid",
		placeItems: "center",
		minWidth: 18,
		height: 18,
		paddingInline: 5,
		borderRadius: 999,
		// Counts only mark waiting work, so they take the action tint.
		backgroundColor: colors.actionTint,
		color: colors.action,
		fontSize: typeScale.size12,
		lineHeight: 1,
		fontWeight: 600,
		fontVariantNumeric: "tabular-nums",
	},
	navCountSelected: {
		backgroundColor: colors.action,
		color: colors.onAction,
	},
	sidebarBottom: {
		display: { default: "flex", [mobile]: "contents" },
		flexDirection: "column",
		gap: space.s2,
		flexShrink: 0,
		minWidth: 0,
	},
	// Phones put the stacked cards' top-bar pills side by side.
	sidebarFooterStack: {
		display: { default: "grid", [mobile]: "flex" },
		alignItems: "center",
		gap: space.s2,
		minWidth: 0,
	},
	sidebarFooter: {
		display: { default: "block", ":empty": "none" },
		gridColumn: 2,
		gridRow: 1,
		minWidth: 0,
	},
	// One 32px row of icon buttons: Settings, Docs and Help, then the app's trailing button.
	// On phones it ends the tab strip's row with Settings and the trailing button only.
	sidebarLinks: {
		display: "flex",
		alignItems: "center",
		gap: space.s1,
		// Spans the pill and account columns so it never widens either.
		gridColumn: "2 / 4",
		justifyContent: { default: "normal", [mobile]: "flex-end" },
		paddingBlock: { default: 0, [mobile]: 6 },
		minWidth: 0,
	},
	sidebarTrailing: {
		display: { default: "flex", ":empty": "none" },
		alignItems: "center",
		gap: space.s1,
		// Phones keep it beside Settings at the end of the tab strip's row.
		marginLeft: { default: "auto", [mobile]: 0 },
	},
	sidebarLinksCompact: {
		flexDirection: { default: "column", [mobile]: "row" },
	},
	sidebarTrailingCompact: {
		flexDirection: { default: "column", [mobile]: "row" },
		marginLeft: 0,
	},
	// The "leaves the app" arrow on Docs and Help, on the icon's top-right shoulder.
	// A 12px disc cut out of the sidebar surface, clear of the 16px glyph, like the unread dot.
	externalBadge: {
		position: "absolute",
		top: 2,
		insetInlineEnd: 2,
		boxSizing: "border-box",
		width: 12,
		height: 12,
		padding: 2,
		borderRadius: 999,
		backgroundColor: colors.sidebarSurface,
		color: colors.muted,
		pointerEvents: "none",
	},
	// Docs and Help move into the account menu on phones.
	sidebarExternalLink: { display: { default: "grid", [mobile]: "none" } },
	// Icon-only sidebar link: the navigation items' muted colour, hover fill and selected tint.
	navIconButton: {
		position: "relative",
		display: "grid",
		placeItems: "center",
		flexShrink: 0,
		// The phone tab strip keeps 44px targets for every pointer.
		width: { default: size.control, [mobile]: 44 },
		height: { default: size.control, [mobile]: 44 },
		padding: 0,
		borderWidth: 0,
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		color: colors.muted,
		textDecoration: "none",
		outline: "none",
		transitionProperty: {
			default: "background-color, color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	navIconButtonSelected: {
		backgroundColor: {
			default: colors.navSelected,
			":hover": colors.navSelected,
			":focus-visible": colors.navSelected,
		},
		color: colors.action,
	},
	// Below the brand on wide screens; the avatar tile at the end of the first row on phones.
	sidebarAccount: {
		display: "flex",
		alignItems: "center",
		justifySelf: "end",
		flexShrink: 0,
		gridColumn: 3,
		gridRow: 1,
		minWidth: 0,
	},
	main: {
		minWidth: 0,
		// Clips the page bar's full-width fill without making the page a scroll container.
		overflowX: "clip",
		transitionProperty: { default: "opacity", [reducedMotion]: "none" },
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	// Dims only after a short delay, so quick navigation does not flicker.
	mainPending: { opacity: 0.55, transitionDelay: "150ms" },
	content: {
		// Pages use the full width beside the sidebar; settings sections cap their own measure.
		// styles.css steps --page-padding down at 1100px and 760px; the page bar pulls itself up
		// over the top padding (see `layout.pageHeader`).
		padding: "var(--page-padding)",
	},
	// Pages that scroll inside their own panel (Access) fill the viewport on wider screens,
	// so the page itself never scrolls; short windows keep a usable minimum.
	contentFill: {
		display: { default: "flex", [mobile]: "block" },
		flexDirection: "column",
		boxSizing: "border-box",
		height: { default: "max(100dvh, 560px)", [mobile]: "auto" },
	},
	connectionList: {
		backgroundColor: colors.surface,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
		containerType: "inline-size",
	},
	// A flex row with a mark and two text lines; loading skeletons reuse it.
	connectionRow: {
		display: "flex",
		alignItems: "center",
		gap: { default: space.s4, [mobile]: space.s3 },
		padding: `8px ${space.s4}`,
		borderBottomWidth: { default: 1, ":last-child": 0 },
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		flexWrap: { default: "nowrap", [mobile]: "wrap" },
	},
	// One grid for every row: the name column takes the remaining width, the facts and
	// access columns are fixed, and the action column fits the widest row (Reconnect + menu).
	// Below 880px of list width each row stacks instead; see `connectionStacked`.
	connectionGrid: {
		display: { default: "grid", [connectionStacked]: "block" },
		// The action column is fixed and right-aligned so recovery buttons and icons share an edge.
		gridTemplateColumns:
			"minmax(220px, 360px) minmax(160px, 1fr) minmax(150px, 1fr) minmax(150px, 1fr) 148px",
		columnGap: space.s4,
	},
	connectionGridRow: {
		display: "grid",
		gridColumn: "1 / -1",
		gridTemplateColumns: {
			default: "subgrid",
			[connectionStacked]: "minmax(0, 1fr) auto auto",
		},
		gridTemplateAreas: {
			default: "none",
			[connectionStacked]:
				'"main recover actions" "state access access" "facts facts facts"',
		},
		alignItems: "center",
		columnGap: { default: space.s4, [connectionStacked]: space.s3 },
		rowGap: space.s1,
		minHeight: 56,
	},
	// A quiet label row over the hairline; hidden once rows stack.
	connectionHeaderRow: {
		display: { default: "grid", [connectionStacked]: "none" },
		minHeight: 0,
		paddingBlock: space.s2,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		paddingInline: space.s4,
	},
	connectionMain: {
		display: "flex",
		alignItems: "center",
		gap: space.s3,
		minWidth: 0,
		gridArea: { default: "auto", [connectionStacked]: "main" },
	},
	connectionInfo: { flex: 1, minWidth: 0 },
	connectionTitleLine: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minWidth: 0,
	},
	connectionTitle: {
		margin: 0,
		minWidth: 0,
		fontSize: 14,
		lineHeight: text.bodyLeading,
		fontWeight: 500,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	// The ellipsis takes the wrapper's font, so it matches the 12px monospace URL.
	connectionUrl: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: colors.muted,
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	// Counts and freshness are their own grid cells; stacked, they share one wrapped line
	// under the name, past the 32px mark and the 12px gap.
	// Status badge over a muted line: the problem's next step, or when tools were checked.
	connectionState: {
		minWidth: 0,
		gridArea: { default: "auto", [connectionStacked]: "state" },
		marginLeft: { default: 0, [connectionStacked]: 44 },
	},
	connectionFacts: {
		display: { default: "contents", [connectionStacked]: "flex" },
		flexWrap: "wrap",
		columnGap: space.s3,
		minWidth: 0,
		gridArea: { default: "auto", [connectionStacked]: "facts" },
		marginLeft: { default: 0, [connectionStacked]: 44 },
	},
	connectionFact: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
		fontVariantNumeric: "tabular-nums",
	},
	connectionFactError: { color: colors.bad },
	connectionAccess: {
		display: "flex",
		minWidth: 0,
		gridArea: { default: "auto", [connectionStacked]: "access" },
		justifySelf: { default: "start", [connectionStacked]: "end" },
	},
	// Stacked, a visible Reconnect takes its own line so the name keeps the top line.
	connectionGridRowRecover: {
		gridTemplateAreas: {
			default: "none",
			[connectionStacked]:
				'"main recover actions" "state access access" "facts facts facts"',
		},
	},
	connectionActions: {
		display: { default: "flex", [connectionStacked]: "contents" },
		alignItems: "center",
		justifyContent: "flex-end",
		gap: space.s2,
		justifySelf: "end",
	},
	connectionMenu: {
		display: "flex",
		alignItems: "center",
		gap: 2,
		gridArea: { default: "auto", [connectionStacked]: "actions" },
		justifySelf: "end",
	},
	connectionRecover: {
		gridArea: { default: "auto", [connectionStacked]: "recover" },
		justifySelf: "end",
	},
	// A failing row's empty capabilities need no placeholder once rows stack.
	connectionFactEmpty: {
		display: { default: "inline", [connectionStacked]: "none" },
	},
	// The access state is the link; its text ellipsizes inside the fixed column.
	connectionFactLink: {
		display: "inline-flex",
		alignItems: "center",
		maxWidth: "100%",
		minWidth: 0,
		minHeight: { default: 24, [coarse]: 44 },
		marginBlock: { default: -2, [coarse]: -12 },
		// Secondary at rest; the link reads as one on hover or focus.
		color: {
			default: colors.text,
			":hover": colors.action,
			":focus-visible": colors.action,
		},
		fontSize: 13,
		lineHeight: "20px",
		fontWeight: 400,
		fontVariantNumeric: "tabular-nums",
		textDecoration: "none",
		borderRadius: 2,
	},
	connectionFactLinkNone: {
		color: {
			default: colors.muted,
			":hover": colors.action,
			":focus-visible": colors.action,
		},
	},
	connectionFactLinkText: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	muted: { color: colors.muted },
	numeric: { fontVariantNumeric: "tabular-nums" },
	alignEnd: { textAlign: "end" },
	agentAccessLink: {
		color: {
			default: colors.muted,
			":hover": colors.action,
			":focus-visible": colors.action,
		},
		textDecoration: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
		},
		textUnderlineOffset: 2,
		borderRadius: 2,
	},
	tableScroll: {
		overflow: "auto",
		maxWidth: "100%",
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
		backgroundColor: colors.surface,
	},
	table: { borderCollapse: "collapse", width: "100%", textAlign: "left" },
	// A quiet label row over a hairline; no tinted band.
	tableHead: { backgroundColor: "transparent" },
	tableCell: {
		padding: "var(--table-padding)",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		verticalAlign: "middle",
	},
	tableHeader: {
		padding: "var(--table-padding)",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		verticalAlign: "middle",
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
	},
	settingsText: {
		margin: 0,
		fontSize: typeScale.size13,
		lineHeight: typeScale.leading13,
	},
	formDescription: {
		fontSize: typeScale.size13,
		lineHeight: typeScale.leading13,
	},
	// Borderless: a quiet summary row whose caret lines up with the fields above it.
	disclosure: { marginBlock: "var(--field-gap)" },
	disclosureSummary: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minHeight: size.control,
		marginInline: `calc(-1 * ${space.s2})`,
		paddingInline: space.s2,
		listStyle: "none",
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 500,
		cursor: "pointer",
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		transitionProperty: {
			default: "background-color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
		outline: "none",
		"::-webkit-details-marker": { display: "none" },
	},
	disclosureIcon: {
		flexShrink: 0,
		color: colors.muted,
		transitionProperty: { default: "transform", [reducedMotion]: "none" },
		transitionDuration: motion.enter,
		transitionTimingFunction: motion.settle,
	},
	disclosureIconOpen: { transform: "rotate(90deg)" },
	// Indented under the summary label (16px caret + 8px gap).
	disclosureBody: { paddingInlineStart: space.s6 },
	/** The opened fields drop in under the summary. */
	disclosureBodyOpen: {
		animationName: { default: dropIn, [reducedMotion]: "none" },
		animationDuration: motion.enter,
		animationTimingFunction: motion.settle,
	},
	// Spacing alone separates the actions; no rule.
	modalActions: {
		display: "flex",
		justifyContent: "flex-end",
		flexWrap: "wrap",
		gap: space.s2,
		paddingTop: 0,
		marginTop: space.s4,
	},
	// Page notices under the header: the error notice and the connection-added notice.
	pageNotice: { marginBottom: space.s4 },
	noticeRow: { display: "flex", alignItems: "flex-start", gap: space.s2 },
	noticeText: { flex: "1 1 auto", minWidth: 0 },
	// Centres the 28px button on the notice's 18px first line.
	noticeDismiss: {
		marginBlock: { default: -5, [coarse]: -13 },
		marginInlineEnd: -4,
	},
});
