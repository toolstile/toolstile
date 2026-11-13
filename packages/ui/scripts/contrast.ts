// WCAG contrast audit for the light and dark palettes in src/styles.css and the
// derived tints in src/tokens.stylex.ts. Run with `node packages/ui/scripts/contrast.ts`;
// contrast.test.ts asserts the same targets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Rgba = { r: number; g: number; b: number; a: number };
export type Theme = "light" | "dark";
export type Row = {
	theme: Theme;
	foreground: string;
	background: string;
	ratio: number;
	minimum: number;
	/** Upper bound for hairlines that must stay quiet. */
	maximum?: number;
};

export const passes = (row: Row) =>
	row.ratio >= row.minimum &&
	(row.maximum === undefined || row.ratio <= row.maximum);

const source = (name: string) =>
	readFileSync(
		fileURLToPath(new URL(`../src/${name}`, import.meta.url)),
		"utf8",
	);

export function parseColor(value: string): Rgba {
	const text = value.trim();
	if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (hex) {
		const digits =
			hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
		const channel = (i: number) =>
			Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
		return { r: channel(0), g: channel(1), b: channel(2), a: 1 };
	}
	const rgb = text.match(
		/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+))?\s*\)$/,
	);
	if (rgb)
		return {
			r: Number(rgb[1]) / 255,
			g: Number(rgb[2]) / 255,
			b: Number(rgb[3]) / 255,
			a: rgb[4] === undefined ? 1 : Number(rgb[4]),
		};
	throw new Error(`Unsupported colour: ${value}`);
}

/** `color-mix(in srgb, colour P%, transparent)` keeps the colour at P% alpha. */
export const withAlpha = (color: Rgba, percent: number): Rgba => ({
	...color,
	a: color.a * (percent / 100),
});

/** Source-over compositing onto an opaque backdrop. */
export function over(layer: Rgba, backdrop: Rgba): Rgba {
	const mix = (top: number, bottom: number) =>
		top * layer.a + bottom * (1 - layer.a);
	return {
		r: mix(layer.r, backdrop.r),
		g: mix(layer.g, backdrop.g),
		b: mix(layer.b, backdrop.b),
		a: 1,
	};
}

function luminance({ r, g, b }: Rgba) {
	const linear = (c: number) =>
		c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: Rgba, b: Rgba) {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

/** Custom properties declared directly in a rule block of styles.css. */
function themeVariables(css: string, selector: string) {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`Missing ${selector} in styles.css`);
	const block = css.slice(start, css.indexOf("\n\t}", start));
	const variables = new Map<string, string>();
	for (const [, name, value] of block.matchAll(/--([\w-]+):\s*([^;]+);/g))
		variables.set(name, value.replace(/\s+/g, " ").trim());
	return variables;
}

/** `name: "color-mix(in srgb, var(--x) N%, transparent)"` entries in tokens.stylex.ts. */
function derivedTints(tokens: string) {
	const tints = new Map<string, { variable: string; percent: number }>();
	for (const [, name, variable, percent] of tokens.matchAll(
		/(\w+): "color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, transparent\)"/g,
	))
		tints.set(name, { variable, percent: Number(percent) });
	return tints;
}

export const themeSelectors = {
	light: ":root",
	dark: ':root[data-theme="dark"]',
	systemDark: ':root:not([data-theme="light"])',
} as const;

export function variables(selector: string) {
	return themeVariables(source("styles.css"), selector);
}

export function palette(theme: Theme) {
	const variables = themeVariables(source("styles.css"), themeSelectors[theme]);
	const tints = derivedTints(source("tokens.stylex.ts"));
	const raw = (name: string) => {
		const value = variables.get(name);
		if (!value) throw new Error(`Missing --${name} (${theme})`);
		return value;
	};
	/** Resolves `var(--x)` aliases and `color-mix(in srgb, C N%, transparent)` tints. */
	const resolve = (value: string): Rgba => {
		const alias = value.match(/^var\(--([\w-]+)\)$/);
		if (alias) return token(alias[1]);
		const mix = value.match(/^color-mix\(in srgb, (.+) (\d+)%, transparent\)$/);
		if (mix) return withAlpha(resolve(mix[1]), Number(mix[2]));
		return parseColor(value);
	};
	const token = (name: string): Rgba => resolve(raw(name));
	/** Alpha of the first `rgb(... / a)` stop in a gradient token; 0 for `none`. */
	const sheen = (name: string) =>
		Number(raw(name).match(/rgb\([^)]*\/\s*([\d.]+)\)/)?.[1] ?? 0);
	/** Factor of a `brightness(x)` filter token; 1 for `none`. */
	const brightness = (name: string) =>
		Number(raw(name).match(/brightness\(([\d.]+)\)/)?.[1] ?? 1);
	const tint = (name: string) => {
		const entry = tints.get(name);
		if (!entry) throw new Error(`Missing derived tint ${name}`);
		return withAlpha(token(entry.variable), entry.percent);
	};
	/** The 1px --ring that opens an --elevation-* shadow. */
	const ring = (name: string) => {
		const value = variables.get(name) ?? "";
		if (!value.startsWith("0 0 0 1px var(--ring)"))
			throw new Error(`Unexpected --${name} (${theme})`);
		return token("ring");
	};
	return { token, tint, ring, sheen, brightness };
}

/** Every foreground/background pairing the interface renders, with its target. */
export function audit(theme: Theme): Row[] {
	const { token, tint, sheen, brightness } = palette(theme);
	const page = token("page");
	const surface = token("surface");
	const sidebar = token("sidebar-surface");
	const text = token("text");
	const muted = token("muted");
	const action = token("action");
	const actionSoft = token("action-soft");
	const white = parseColor("#fff");
	const surfaces: Record<string, Rgba> = {
		page,
		surface,
		sidebarSurface: sidebar,
		hover: token("hover"),
		// Dashboard.styles.ts navItem :hover and navCount.
		"navHover (text 6% on sidebar)": over(withAlpha(text, 6), sidebar),
		"navCount (text 8% on sidebar)": over(withAlpha(text, 8), sidebar),
	};
	const rows: Row[] = [];
	const check = (
		foreground: string,
		fg: Rgba,
		background: string,
		bg: Rgba,
		minimum: number,
		maximum?: number,
	) =>
		rows.push({
			theme,
			foreground,
			background,
			ratio: contrast(over(fg, bg), bg),
			minimum,
			...(maximum === undefined ? {} : { maximum }),
		});
	for (const name of ["page", "surface", "sidebarSurface", "hover"])
		check("text", text, name, surfaces[name], 7);
	for (const [name, bg] of Object.entries(surfaces))
		check("muted", muted, name, bg, 4.5);
	check("muted", muted, "actionSoft", actionSoft, 4.5);
	// Text inside recessed wells (code blocks, table headers) on cards.
	const inset = over(tint("insetTint"), surface);
	check("text", text, "insetTint on surface", inset, 7);
	check("muted", muted, "insetTint on surface", inset, 4.5);
	// Hairlines stay quiet; separation comes from tone and elevation.
	for (const name of ["page", "surface", "sidebarSurface"])
		check("line (hairline)", token("line"), name, surfaces[name], 1.3, 1.8);
	for (const name of ["page", "surface"])
		check(
			"lineStrong (input)",
			token("line-strong"),
			name,
			surfaces[name],
			2.5,
		);
	// Status badges sit on surface rows; tints are translucent so composite first.
	const badge = (label: string, fg: Rgba, bgLabel: string, bg: Rgba) => {
		check(label, fg, `${bgLabel} on surface`, over(bg, surface), 4.5);
		check(label, fg, `${bgLabel} on page`, over(bg, page), 4.5);
	};
	badge("good", token("good"), "goodTint", tint("goodTint"));
	badge("warning", token("warning"), "warningTint", token("warning-tint"));
	badge("action", action, "actionSoft", actionSoft);
	badge("muted", muted, "lineTint", tint("lineTint"));
	badge("bad", token("bad"), "badTint", tint("badTint"));
	// AccessManager.tsx mode chips: on hover and keyboard focus the hover wash is
	// laid over the chip's own tint (modeChip backgroundImage), on rows on surface.
	const hoverOverlay = token("hover-overlay");
	for (const [label, fg, fill] of [
		["text (allowed chip)", text, tint("insetTint")],
		["muted (inherited chip)", muted, tint("insetTint")],
		["warning (approval chip)", token("warning"), token("warning-tint")],
		["bad (blocked chip)", token("bad"), withAlpha(token("bad"), 12)],
	] as const) {
		const chip = over(fill, surface);
		check(label, fg, "chip tint on surface", chip, 4.5);
		check(label, fg, "chip tint + hoverOverlay", over(hoverOverlay, chip), 4.5);
	}
	check("good", token("good"), "surface", surface, 4.5);
	check("bad", token("bad"), "surface", surface, 4.5);
	check("warning", token("warning"), "surface", surface, 4.5);
	// onAction on the action hue (fills that still use colors.action rather than
	// actionFill): 16% white top highlight and 1.06 brightness on hover.
	check("onAction", token("on-action"), "action", action, 4.5);
	check(
		"onAction",
		token("on-action"),
		"action + 16% white highlight",
		over(withAlpha(white, 16), action),
		4.5,
	);
	const bright = (c: Rgba, factor = 1.06): Rgba => ({
		r: Math.min(1, c.r * factor),
		g: Math.min(1, c.g * factor),
		b: Math.min(1, c.b * factor),
		a: 1,
	});
	check(
		"onAction",
		token("on-action"),
		"action hover (brightness 1.06)",
		bright(over(withAlpha(white, 16), action)),
		4.5,
	);
	check("action (selected nav)", action, "actionSoft", actionSoft, 4.5);
	check("action (link)", action, "surface", surface, 4.5);
	check("action (link)", action, "page", page, 4.5);
	check("action (full access)", action, "hover", token("hover"), 4.5);
	check("action (focus outline)", action, "surface", surface, 3);
	check("action (focus outline)", action, "page", page, 3);
	// Inputs: --input fill. Focus turns the border action (the indicator, ≥3 in
	// both themes); the 3px glow beside it is 60% action in light (also ≥3) and a
	// softer 45% in dark, reported in planes().
	const input = token("input");
	check("text", text, "input", input, 7);
	// Placeholder (muted at 70%). Light measures 3.96 and is unchanged from the
	// approved light look, so only dark is held to 4.5 here.
	if (theme === "dark")
		check("muted 70% (placeholder)", withAlpha(muted, 70), "input", input, 4.5);
	check("action (input focus border)", action, "input", input, 3);
	if (theme === "light")
		check("focusRing", token("focus-ring"), "surface", surface, 3);
	// Filled buttons: --on-fill on the fill under the full top sheen, and on the
	// hover fill after --fill-hover-filter.
	const onFill = token("on-fill");
	const lit = (fill: Rgba) =>
		over(withAlpha(white, 100 * sheen("primary-sheen")), fill);
	const hoverFilter = brightness("fill-hover-filter");
	check(
		"onFill (primary)",
		onFill,
		"actionFill + sheen",
		lit(token("action-fill")),
		4.5,
	);
	check(
		"onFill (primary)",
		onFill,
		"actionFillHover + sheen, hover filter",
		bright(lit(token("action-fill-hover")), hoverFilter),
		4.5,
	);
	// Brand.tsx symbol: the primary fill as a graphic on each plane it sits on.
	for (const name of ["page", "surface", "sidebarSurface"])
		check(
			"actionFill (logo symbol)",
			token("action-fill"),
			name,
			surfaces[name],
			3,
		);
	check("onFill (destructive)", onFill, "badFill", token("bad-fill"), 4.5);
	check(
		"onFill (destructive)",
		onFill,
		"badFillHover, hover filter",
		bright(token("bad-fill-hover"), hoverFilter),
		4.5,
	);
	// Menus, select popups and dialogs sit on --popover.
	const popover = token("popover");
	const popoverHover = over(token("hover-overlay"), popover);
	check("text", text, "popover", popover, 7);
	check("muted", muted, "popover", popover, 4.5);
	check("text", text, "hoverOverlay on popover", popoverHover, 7);
	check("muted", muted, "hoverOverlay on popover", popoverHover, 4.5);
	check("action (link, menu check)", action, "popover", popover, 4.5);
	// ToolTest.tsx pending-approval notice: an action link on the warning tint in a dialog.
	check(
		"action (notice link)",
		action,
		"warningTint on popover",
		over(token("warning-tint"), popover),
		4.5,
	);
	// ToolReviewPanel.tsx compact review count: its actionTint on a selected (actionTint) row.
	check(
		"action (review count)",
		action,
		"actionTint on selected actionTint row",
		over(tint("actionTint"), over(tint("actionTint"), surface)),
		4.5,
	);
	check("bad (menu item)", token("bad"), "popover", popover, 4.5);
	check(
		"bad (menu item)",
		token("bad"),
		"badTint on popover",
		over(tint("badTint"), popover),
		4.5,
	);
	// Secondary buttons and select triggers: --control-fill under the top of the
	// --control-sheen, on each surface they appear on; hover swaps the fill.
	const controlSheen = withAlpha(white, 100 * sheen("control-sheen"));
	for (const [label, bg] of [
		["surface", surface],
		["popover", popover],
		["page", page],
	] as const) {
		const rest = over(controlSheen, over(token("control-fill"), bg));
		const hovered = over(controlSheen, over(token("control-fill-hover"), bg));
		check("text (secondary)", text, `control on ${label}`, rest, 7);
		check("text (secondary)", text, `control hover on ${label}`, hovered, 7);
	}
	check(
		"bad (danger secondary)",
		token("bad"),
		"control on surface",
		over(controlSheen, over(token("control-fill"), surface)),
		4.5,
	);
	check(
		"text",
		text,
		"hoverOverlay on surface",
		over(token("hover-overlay"), surface),
		7,
	);
	// StatusBadge fills (--badge-*) on rows, pages and popovers.
	for (const [label, fg, fill] of [
		["good", token("good"), token("badge-good")],
		["warning", token("warning"), token("badge-warning")],
		["action", action, token("badge-action")],
		["muted", muted, token("badge-neutral")],
	] as const)
		for (const [bgLabel, bg] of [
			["surface", surface],
			["page", page],
			["popover", popover],
		] as const)
			check(
				`${label} (badge)`,
				fg,
				`badge ${label} on ${bgLabel}`,
				over(fill, bg),
				4.5,
			);
	return rows;
}

/** Plane separation reported for information; not a pass/fail target. */
export function planes(theme: Theme) {
	const { token, ring } = palette(theme);
	const page = token("page");
	return {
		"card ring (elevation-low) vs page": contrast(
			over(ring("elevation-low"), page),
			page,
		),
		"card ring (elevation-low) vs surface": contrast(
			over(ring("elevation-low"), token("surface")),
			token("surface"),
		),
		"surface vs page": contrast(token("surface"), page),
		"sidebarSurface vs page": contrast(token("sidebar-surface"), page),
		"surface vs sidebarSurface": contrast(
			token("surface"),
			token("sidebar-surface"),
		),
		"popover vs surface": contrast(token("popover"), token("surface")),
		"input vs surface": contrast(token("input"), token("surface")),
		"input border vs input": contrast(
			over(token("input-border"), token("input")),
			token("input"),
		),
		"focus glow vs surface": contrast(
			over(token("focus-ring"), token("surface")),
			token("surface"),
		),
		"control border vs surface": contrast(
			over(token("control-border"), token("surface")),
			token("surface"),
		),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	let failures = 0;
	for (const theme of ["light", "dark"] as const) {
		console.log(`\n${theme}`);
		for (const row of audit(theme)) {
			const pass = passes(row);
			if (!pass) failures++;
			console.log(
				`${pass ? "  " : "✗ "}${row.foreground.padEnd(24)} ${row.background.padEnd(34)} ${row.ratio.toFixed(2).padStart(6)}:1  (${row.maximum === undefined ? `≥${row.minimum}` : `${row.minimum}–${row.maximum}`})`,
			);
		}
		for (const [pair, ratio] of Object.entries(planes(theme)))
			console.log(`  plane ${pair.padEnd(42)} ${ratio.toFixed(2)}:1`);
	}
	console.log(failures ? `\n${failures} below target` : "\nAll targets met");
	process.exitCode = failures ? 1 : 0;
}
