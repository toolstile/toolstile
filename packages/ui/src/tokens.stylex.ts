import * as stylex from "@stylexjs/stylex";

// Bridge the existing system/light/dark theme while components move to StyleX.
export const colors = stylex.defineVars({
	page: "var(--page)",
	surface: "var(--surface)",
	text: "var(--text)",
	muted: "var(--muted)",
	/** Hairline (~1.3-1.8:1): row dividers, the tab underline and the sidebar edge. */
	line: "var(--line)",
	/** Rest border for form controls (inputs, selects), ~2.5:1 on surface. */
	lineStrong: "var(--line-strong)",
	/** 1px edge that opens every elevation shadow; ink in light, white in dark. */
	ring: "var(--ring)",
	action: "var(--action)",
	onAction: "var(--on-action)",
	good: "var(--good)",
	bad: "var(--bad)",
	warning: "var(--warning)",
	warningTint: "var(--warning-tint)",
	hover: "var(--hover)",
	/** Tinted action background: selected navigation, primary hover halo, "Needs sign-in". */
	actionSoft: "var(--action-soft)",
	/** Selected navigation fill: the action tint in light, the navy actionSoft in dark. */
	navSelected: "var(--nav-selected)",
	/** Group header bands inside a list (device groups, review sections, day groups). */
	band: "var(--band)",
	/** Navigation rail: one soft step below the page in light, a hair lighter than the page in dark. */
	sidebarSurface: "var(--sidebar-surface)",
	// Tints derive from the approved hues so both themes stay in sync.
	goodTint: "color-mix(in srgb, var(--good) 12%, transparent)",
	badTint: "color-mix(in srgb, var(--bad) 10%, transparent)",
	actionTint: "color-mix(in srgb, var(--action) 12%, transparent)",
	/** Neutral badge and skeleton fill. */
	lineTint: "color-mix(in srgb, var(--muted) 10%, transparent)",
	/** Recessed wells inside a card: code blocks, table headers, segmented tracks. A muted tint keeps them on the cool neutral ramp. */
	insetTint: "color-mix(in srgb, var(--muted) 8%, transparent)",
	/** Input focus glow: 60% action in light, 45% in dark (styles.css --focus-ring). */
	focusRing: "var(--focus-ring)",
	/** Primary button fill; the action hue in light, a lighter blue on the same hue in dark; also the logo symbol. */
	actionFill: "var(--action-fill)",
	actionFillHover: "var(--action-fill-hover)",
	/** Filled destructive button; the bad hue in light, a deep rose in dark. */
	badFill: "var(--bad-fill)",
	badFillHover: "var(--bad-fill-hover)",
	/** Text on actionFill and badFill. */
	onFill: "var(--on-fill)",
	/** Secondary buttons and select triggers: fill, hover fill and 1px edge. */
	controlFill: "var(--control-fill)",
	controlFillHover: "var(--control-fill-hover)",
	controlBorder: "var(--control-border)",
	controlBorderHover: "var(--control-border-hover)",
	/** Quiet-button and menu-item hover: a translucent ink overlay in light, a 7% white overlay in dark. */
	hoverOverlay: "var(--hover-overlay)",
	/** Menus, select popups and dialogs; one tone above cards in dark. */
	popover: "var(--popover)",
	/** Scrim behind dialogs. */
	backdrop: "var(--backdrop)",
	/** Text inputs: one tone below cards in dark, with a quiet 1px edge. */
	input: "var(--input)",
	inputBorder: "var(--input-border)",
	inputBorderHover: "var(--input-border-hover)",
});

/** StatusBadge fills; light reuses the derived tints, dark uses saturated 14-18% washes. */
export const badgeTints = stylex.defineVars({
	good: "var(--badge-good)",
	warning: "var(--badge-warning)",
	action: "var(--badge-action)",
	neutral: "var(--badge-neutral)",
	/** Brightens the status dot above its label in dark; none in light. */
	dotFilter: "var(--badge-dot-filter)",
});

export const geometry = stylex.defineVars({
	corner: "6px",
	/** Badges, tags and navigation counts. */
	cornerSmall: "4px",
	spacing: "var(--space)",
	fontSans: '"IBM Plex Sans", sans-serif',
	fontMono: '"IBM Plex Mono", monospace',
});

/** Surface shadows; light and dark values live in styles.css. */
export const elevation = stylex.defineVars({
	low: "var(--elevation-low)",
	medium: "var(--elevation-medium)",
	high: "var(--elevation-high)",
	/** 1px inner top highlight on filled buttons: 12% white in light, 18% in dark. */
	primaryHighlight: "var(--primary-highlight)",
	/** Top-lit sheen on the primary fill. */
	primarySheen: "var(--primary-sheen)",
	/** Primary outer shadow at rest and on hover; a cobalt glow in dark. */
	primaryShadow: "var(--primary-shadow)",
	primaryShadowHover: "var(--primary-shadow-hover)",
	/** Filled destructive shadow at rest and on hover; a rose glow in dark. */
	dangerShadow: "var(--danger-shadow)",
	dangerShadowHover: "var(--danger-shadow-hover)",
	/** Hover brightening of filled buttons: brightness(1.06) in light, none in dark. */
	fillHoverFilter: "var(--fill-hover-filter)",
	/** Secondary-control sheen and inner highlight; none in light. */
	controlSheen: "var(--control-sheen)",
	controlShadow: "var(--control-shadow)",
	/** Recessed look for inputs in dark; none in light. */
	inputShadow: "var(--input-shadow)",
	/** Ring on a highlighted menu item in dark; none in light. */
	itemRing: "var(--item-ring)",
	/** Soft glow on the selected navigation indicator in dark; none in light. */
	navIndicatorGlow: "var(--nav-indicator-glow)",
	/** 1px edge on connection monogram tiles. */
	tileRing: "var(--tile-ring)",
});

/** Type scale: sizes with matching line heights and tracking. */
export const typeScale = stylex.defineVars({
	size12: "12px",
	// Interface body text; 14px for comfortable reading (was 13px).
	size13: "14px",
	size14: "14px",
	size16: "16px",
	size20: "20px",
	size28: "28px",
	leading12: "16px",
	leading13: "20px",
	leading14: "20px",
	leading16: "24px",
	leading20: "28px",
	leading28: "34px",
	trackingTight: "-0.01em",
	trackingNormal: "0",
});

const coarse = "@media (pointer: coarse)";

/** 4px rhythm for padding, gaps and margins. */
export const space = stylex.defineVars({
	s0_5: "2px",
	s1: "4px",
	s2: "8px",
	s3: "12px",
	s4: "16px",
	s5: "20px",
	s6: "24px",
	s8: "32px",
	s10: "40px",
});

/** Component dimensions; coarse pointers grow targets to 44px here, once. */
export const size = stylex.defineVars({
	/** Row and toolbar icon buttons. */
	controlSm: { default: "28px", [coarse]: "44px" },
	/** Buttons, inputs, selects, menu items and navigation. */
	control: { default: "32px", [coarse]: "44px" },
	/** Account and marketing screens only. */
	controlLg: { default: "40px", [coarse]: "44px" },
	tab: { default: "36px", [coarse]: "44px" },
	/** Single-line list rows. */
	row: "40px",
	/** Matrix cells. */
	rowDense: { default: "32px", [coarse]: "44px" },
	check: { default: "16px", [coarse]: "20px" },
	icon: "16px",
	iconLg: "20px",
	mark: "32px",
	markSm: "24px",
	sidebar: "224px",
	settingsNav: "200px",
	rail: "220px",
	contentMax: "1080px",
	proseMax: "720px",
	dialogSm: "420px",
	dialogMd: "560px",
	dialogLg: "680px",
});

/** Semantic type roles; `typeScale` keeps its literal sizes for compatibility. */
export const text = stylex.defineVars({
	pageTitle: "22px",
	pageTitleLeading: "30px",
	dialogTitle: "16px",
	dialogTitleLeading: "24px",
	sectionTitle: "14px",
	sectionTitleLeading: "20px",
	/** UI default: rows, controls, navigation and tables. */
	body: "14px",
	bodyLeading: "22px",
	/** Markdown and long help only. */
	prose: "14px",
	proseLeading: "22px",
	/** Identifiers, badges and timestamps. */
	meta: "12px",
	metaLeading: "16px",
	metric: "26px",
	metricLeading: "32px",
	/** Text inputs; 16px on coarse pointers avoids iOS focus zoom. */
	input: { default: "14px", [coarse]: "16px" },
});

export const motion = stylex.defineVars({
	fast: "120ms",
	base: "150ms",
	slow: "200ms",
	/** A surface arriving: popups, dialogs and pages settle in over this. */
	enter: "240ms",
	easeOut: "cubic-bezier(0.2, 0.8, 0.2, 1)",
	/** Arrives at speed and settles with a long soft tail (expo-out). */
	settle: "cubic-bezier(0.22, 1, 0.36, 1)",
	/** A surface leaving: accelerates away. */
	easeIn: "cubic-bezier(0.4, 0, 1, 1)",
});
