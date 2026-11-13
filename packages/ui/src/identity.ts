// Pure colour helpers for ConnectionMark; kept free of StyleX so they can be unit tested.
type Rgb = [number, number, number];

/** Host including any port, so local servers on different ports stay distinguishable. */
export function connectionHost(url: string) {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/** FNV-1a, so the same host always gets the same hue. */
function hash(value: string) {
	let result = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 0x01000193);
	}
	return result >>> 0;
}

export function hslToRgb(
	hue: number,
	saturation: number,
	lightness: number,
): Rgb {
	const s = saturation / 100,
		l = lightness / 100;
	const a = s * Math.min(l, 1 - l);
	const channel = (n: number) => {
		const k = (n + hue / 30) % 12;
		return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
	};
	return [channel(0), channel(8), channel(4)];
}

function luminance([r, g, b]: Rgb) {
	const linear = (c: number) =>
		c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgb, b: Rgb) {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

const css = (hue: number, saturation: number, lightness: number) =>
	`hsl(${hue} ${saturation}% ${lightness}%)`;

/**
 * Deterministic tile colours for a connection host (hostname and port). Background saturation and lightness are
 * fixed per theme; the text lightness is stepped until it reaches at least 7:1 contrast.
 */
export function connectionMarkColors(url: string) {
	const hue = hash(connectionHost(url).toLowerCase()) % 360;
	const lightBackground = hslToRgb(hue, 70, 92);
	let lightText = 34;
	while (
		lightText > 5 &&
		contrastRatio(hslToRgb(hue, 60, lightText), lightBackground) < 7
	)
		lightText -= 2;
	// Saturated enough that the hue still reads on the near-black dark page.
	const darkBackground = hslToRgb(hue, 56, 22);
	let darkText = 78;
	while (
		darkText < 97 &&
		contrastRatio(hslToRgb(hue, 80, darkText), darkBackground) < 7
	)
		darkText += 2;
	return {
		hue,
		light: { background: css(hue, 70, 92), text: css(hue, 60, lightText) },
		dark: { background: css(hue, 56, 22), text: css(hue, 80, darkText) },
	};
}
