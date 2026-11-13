/// <reference path="./assets.d.ts" />
import * as stylex from "@stylexjs/stylex";
import faviconPngUrl from "./assets/toolstile-favicon-32.png?url";
import iconUrl from "./assets/toolstile-square.svg?url";
import touchIconUrl from "./assets/toolstile-touch-180.png?url";
import { colors, elevation, geometry } from "./tokens.stylex";

export const toolstileIconUrl = iconUrl;

/** Approved padded square mark, shared by each application's document head. */
export const toolstileIconLinks = [
	{ rel: "icon", type: "image/png", sizes: "32x32", href: faviconPngUrl },
	{ rel: "icon", type: "image/svg+xml", sizes: "any", href: iconUrl },
	{ rel: "apple-touch-icon", sizes: "180x180", href: touchIconUrl },
] as const;

/*
 * The approved Junction symbol and Precision lettering as vector paths, traced with potrace
 * from the extraction of the approved lockup (2172 x 724 px). Path units are tenths of those
 * pixels with y pointing up, hence the `raster` transform. The lockup keeps the extraction's
 * composition: the symbol scaled 0.9 with its base bar on the wordmark baseline, and a gap of
 * 0.45 cap heights before the lettering.
 */
const raster = "translate(0 724) scale(0.1 -0.1)";
const junction =
	"M1086 5192 c-3 -5 -5 -163 -5 -350 l0 -341 22 -3 c12 -2 428 -2 925 0 1014 5 973 8 1091 -68 66 -43 113 -102 306 -389 159 -236 240 -338 331 -414 79 -68 258 -160 343 -178 63 -14 89 -29 49 -29 -38 0 -154 -38 -223 -72 -158 -80 -293 -202 -418 -380 -94 -132 -165 -198 -247 -229 l-65 -24 -1055 -5 -1055 -5 0 -350 0 -350 1030 -3 c1148 -3 1200 -1 1362 53 257 86 404 205 609 493 172 242 195 271 246 317 66 59 165 114 247 137 61 17 128 18 1003 18 l938 0 0 415 0 415 -912 0 c-998 0 -998 0 -1123 59 -149 70 -190 117 -515 595 -112 165 -229 331 -260 371 -104 130 -262 238 -435 296 l-70 24 -1057 3 c-612 1 -1059 -1 -1062 -6z M1082 3603 l3 -358 840 -5 840 -5 44 -25 c28 -16 62 -49 90 -89 60 -84 88 -103 153 -108 81 -6 119 21 195 137 81 123 143 186 216 221 l59 28 -56 26 c-82 39 -153 110 -240 240 -84 125 -147 185 -248 236 -118 60 -103 59 -1041 59 l-857 0 2 -357z";
const lettering =
	"M17332 4809 c-153 -26 -247 -138 -247 -294 1 -181 124 -295 320 -295 181 0 304 102 321 266 22 212 -161 362 -394 323z M6942 4468 l3 -283 363 -5 364 -5 0 -1008 0 -1007 342 2 341 3 3 1008 2 1007 385 0 385 0 0 285 0 285 -1095 0 -1095 0 2 -282z M13150 3455 l0 -1295 306 2 306 3 1 1290 1 1290 -307 3 -307 2 0 -1295z M17948 4443 c-2 -170 -2 -752 0 -1295 l2 -988 305 0 304 0 -2 1293 -2 1292 -302 3 -302 2 -3 -307z M15937 4443 c-4 -3 -7 -93 -7 -200 l0 -193 -67 0 c-38 0 -98 -3 -135 -7 l-68 -6 0 -238 0 -239 134 0 135 0 4 -492 c4 -582 6 -595 117 -744 138 -184 505 -249 844 -149 l41 12 3 64 c2 35 1 146 -3 246 l-7 183 -42 -8 c-90 -16 -232 -9 -263 14 -63 46 -63 49 -63 482 l0 392 195 0 195 0 0 239 0 238 -37 7 c-21 3 -108 6 -194 6 l-156 0 -8 138 c-3 76 -5 165 -4 197 l3 60 -305 3 c-168 1 -308 -1 -312 -5z M9585 4089 c-427 -58 -743 -312 -871 -699 -39 -120 -42 -396 -6 -529 119 -431 509 -714 1007 -728 640 -19 1107 398 1107 987 0 374 -172 658 -513 847 -181 101 -495 154 -724 122z m260 -524 c223 -28 393 -270 358 -511 -54 -374 -511 -527 -775 -259 -259 263 -108 726 252 775 54 7 68 7 165 -5z M11802 4090 c-420 -53 -754 -311 -870 -670 -98 -303 -43 -632 148 -887 294 -393 915 -521 1396 -288 548 265 725 917 384 1420 -206 303 -639 477 -1058 425z m298 -536 c79 -22 129 -54 195 -126 303 -327 2 -850 -437 -757 -352 75 -478 521 -220 776 120 118 283 156 462 107z M14680 4094 c-14 -2 -58 -9 -98 -15 -363 -53 -612 -301 -612 -609 1 -324 204 -494 700 -585 313 -57 384 -93 366 -190 -25 -130 -307 -155 -565 -48 -82 33 -227 119 -251 148 -7 8 -16 15 -21 15 -11 0 -289 -355 -289 -371 0 -33 207 -163 348 -218 485 -188 1027 -111 1282 184 147 169 162 466 33 653 -102 148 -269 223 -690 307 -246 49 -293 73 -293 148 0 181 405 165 659 -26 35 -26 64 -47 65 -45 2 2 23 30 48 63 24 33 75 103 113 155 37 52 79 109 92 127 l25 32 -69 50 c-190 141 -428 219 -693 226 -69 2 -136 2 -150 -1z M19580 4094 c-470 -60 -792 -329 -906 -759 -29 -110 -27 -360 5 -480 119 -458 520 -738 1051 -737 372 1 675 126 856 354 43 54 43 52 -13 84 -27 15 -111 64 -188 109 -77 45 -156 91 -176 102 l-35 20 -57 -53 c-99 -92 -237 -144 -384 -144 -208 0 -416 143 -449 308 l-6 32 731 0 731 0 0 128 c0 525 -307 913 -805 1017 -79 16 -286 27 -355 19z m272 -485 c107 -36 194 -110 239 -204 50 -104 89 -95 -391 -95 -329 0 -420 3 -420 13 1 23 41 101 77 149 104 136 321 196 495 137z M17314 4043 l-211 -3 -6 -188 c-8 -277 -9 -1378 -1 -1546 l7 -146 301 2 301 3 3 936 2 936 -46 7 c-26 3 -68 5 -93 4 -25 -2 -141 -4 -257 -5z";

/** The symbol alone, in the extraction's pixels (x 106-654, y 202-526). */
const markBox = "106 202 548 324";

/**
 * The Toolstile logo. `sidebar` is the navigation lockup (dashboard sidebar and site header),
 * `page` the sign-in, consent and recovery lockup, and `mark` the symbol alone for the compact
 * rail. `inverse` draws pale cobalt and white for coloured panels.
 */
export function Brand({
	size = "page",
	tone = "default",
}: {
	size?: "sidebar" | "page" | "mark";
	tone?: "default" | "inverse";
}) {
	const inverse = tone === "inverse";
	const symbol = (
		<path
			d={junction}
			transform={raster}
			{...stylex.props(styles.symbol, inverse && styles.symbolInverse)}
		/>
	);
	if (size === "mark")
		return (
			<svg
				role="img"
				aria-label="Toolstile"
				viewBox={markBox}
				{...stylex.props(styles.svg, styles.mark)}
			>
				{symbol}
			</svg>
		);
	return (
		<svg
			role="img"
			aria-label="Toolstile"
			viewBox="108.5 220 1986 292"
			{...stylex.props(
				styles.svg,
				size === "sidebar" ? styles.sidebar : styles.page,
			)}
		>
			<g transform="translate(106.25 218.37) scale(0.9) translate(-106 -202)">
				{symbol}
			</g>
			<path
				d={lettering}
				transform={`translate(20.2 0) ${raster}`}
				{...stylex.props(styles.letters, inverse && styles.lettersInverse)}
			/>
		</svg>
	);
}

/** The symbol alone in the current text colour, for diagrams that sit on a coloured fill. */
export function JunctionMark({ width }: { width: number }) {
	return (
		<svg
			aria-hidden="true"
			viewBox={markBox}
			width={width}
			height={(width * 324) / 548}
			{...stylex.props(styles.svg, styles.current)}
		>
			<path d={junction} transform={raster} />
		</svg>
	);
}

const styles = stylex.create({
	svg: { display: "block", flexShrink: 0 },
	// Cap height about 11px: a step above the 13px account name beneath it.
	sidebar: { height: 14, width: "auto", aspectRatio: "1986 / 292" },
	page: { height: 22, width: "auto", aspectRatio: "1986 / 292" },
	mark: { height: 16, width: "auto", aspectRatio: "548 / 324" },
	symbol: {
		fill: {
			default: colors.actionFill,
			"@media (forced-colors: active)": "CanvasText",
		},
	},
	letters: {
		fill: {
			default: colors.text,
			"@media (forced-colors: active)": "CanvasText",
		},
	},
	symbolInverse: { fill: "#b9c7ff" },
	lettersInverse: { fill: "#fff" },
	current: { fill: "currentColor" },
});

// One ink for both themes keeps the grid within 6% (light) and 10% (dark); light-dark() is not used because the StyleX CSS pass rewrites it into undefined polyfill variables.
const dotInk = `color-mix(in srgb, ${colors.text} 6%, transparent)`;

/** Shared backdrop and raised card for sign-in, consent and recovery pages. */
export const standalone = stylex.create({
	backdrop: {
		backgroundColor: colors.page,
		// The page-coloured radial wash fades the dot grid towards the edges, so it reads strongest behind the card.
		backgroundImage: {
			default: `radial-gradient(ellipse 60% 55% at 50% 50%, transparent 0%, transparent 30%, ${colors.page} 100%), radial-gradient(circle at 1px 1px, ${dotInk} 1px, transparent 1.5px)`,
			"@media (max-width: 760px)": `radial-gradient(ellipse 90% 50% at 50% 30%, transparent 0%, transparent 30%, ${colors.page} 100%), radial-gradient(circle at 1px 1px, ${dotInk} 1px, transparent 1.5px)`,
		},
		backgroundSize: "100% 100%, 16px 16px",
		backgroundRepeat: "no-repeat, repeat",
		"@media (forced-colors: active)": { backgroundImage: "none" },
	},
	card: {
		backgroundColor: colors.surface,
		color: colors.text,
		borderRadius: geometry.corner,
		boxShadow: elevation.high,
		padding: { default: 32, "@media (max-width: 760px)": 24 },
		minWidth: 0,
		"@media (forced-colors: active)": {
			borderWidth: 1,
			borderStyle: "solid",
			borderColor: "CanvasText",
		},
	},
});
