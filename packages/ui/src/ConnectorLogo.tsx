import { PlugsConnectedIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type SyntheticEvent, useState } from "react";
import { colors } from "./tokens.stylex";

/**
 * Whether a loaded logo is a dark monochrome mark (GitHub, Notion, Linear...): most of its
 * visible pixels are near-black and unsaturated. Such marks invert in dark mode so they stay
 * legible on the dark tile; coloured artwork is left as published.
 */
export function darkMonochrome(image: HTMLImageElement) {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 24;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return false;
		context.drawImage(image, 0, 0, 24, 24);
		const { data } = context.getImageData(0, 0, 24, 24);
		let visible = 0,
			dark = 0,
			light = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i + 3] < 128) continue;
			const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
			const max = Math.max(r, g, b),
				min = Math.min(r, g, b);
			visible++;
			if (max - min > 40) continue;
			if (max < 90) dark++;
			else if (min > 200) light++;
		}
		// Black-on-transparent, or black artwork on a white field.
		return visible > 0 && dark / visible > 0.25 && (dark + light) / visible > 0.9;
	} catch {
		return false;
	}
}

/**
 * Publisher artwork from the catalog, by its content-addressed URL, shown as an image so SVG
 * markup is never inserted into the page. A missing logo shows a generic connection mark.
 */
export function ConnectorLogo({
	logoUrl,
	large = false,
	size,
	eager = false,
}: {
	logoUrl?: string | null;
	/** Above-the-fold logos load eagerly; others wait until they are near the viewport. */
	eager?: boolean;
	large?: boolean;
	size?: number;
}) {
	const imageSize = size
		? Math.round(size * (size >= 28 ? 0.64 : 0.8))
		: large
			? 44
			: 28;
	const usable = logoUrl?.startsWith("/connector-logos/") ? logoUrl : undefined;
	const [mono, setMono] = useState(false);
	const onLoad = (event: SyntheticEvent<HTMLImageElement>) =>
		setMono(darkMonochrome(event.currentTarget));
	return (
		<span
			aria-hidden="true"
			{...stylex.props(
				s.tile,
				large && s.large,
				size ? s.size(size) : null,
				!usable && s.fallback,
			)}
		>
			{usable ? (
				<img
					src={usable}
					alt=""
					width={imageSize}
					height={imageSize}
					decoding="async"
					loading={eager ? "eager" : "lazy"}
					onLoad={onLoad}
					{...stylex.props(s.image, mono && s.mono)}
				/>
			) : (
				<PlugsConnectedIcon size={imageSize} />
			)}
		</span>
	);
}
const s = stylex.create({
	tile: {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: 44,
		height: 44,
		padding: 8,
		flexShrink: 0,
		// White in light; a raised dark tile in dark, so a column of logos never glares.
		backgroundColor:
			"color-mix(in srgb, #1c2029 calc(var(--theme-dark) * 100%), #fff)",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: colors.line,
		borderRadius: 8,
		boxSizing: "border-box",
	},
	large: { width: 64, height: 64, padding: 10 },
	size: (value: number) => ({
		width: value,
		height: value,
		// Small tiles (chips) keep the artwork legible with a thinner inset.
		padding: value >= 40 ? 8 : value >= 28 ? 5 : 2,
		borderRadius: value >= 28 ? 8 : 4,
	}),
	image: { objectFit: "contain", maxWidth: "100%", maxHeight: "100%" },
	// --theme-dark is 0 or 1, so the inversion applies only in dark mode.
	mono: { filter: "invert(calc(var(--theme-dark) * 0.92))" },
	fallback: { color: colors.muted },
});
