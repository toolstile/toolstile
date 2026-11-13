import * as stylex from "@stylexjs/stylex";
import type { CSSProperties } from "react";
import { ConnectorLogo } from "./ConnectorLogo";
import { connectionHost, connectionMarkColors } from "./identity";
import { elevation, geometry } from "./tokens.stylex";

export { connectionMarkColors } from "./identity";

/**
 * The catalog logo the server matched to a connection, else a monogram tile: first letter of
 * its label on a host-derived hue. Only the logo is a (same-origin, cacheable) request.
 */
export function ConnectionMark({
	label,
	url,
	size = 32,
	logoUrl,
}: {
	label: string;
	url: string;
	size?: number;
	logoUrl?: string | null;
}) {
	if (logoUrl) return <ConnectorLogo logoUrl={logoUrl} size={size} />;
	const letter = (
		label.match(/[\p{L}\p{N}]/u)?.[0] ||
		connectionHost(url).slice(0, 1) ||
		"?"
	).toLocaleUpperCase();
	const { light, dark } = connectionMarkColors(url);
	const props = stylex.props(styles.mark);
	return (
		<span
			aria-hidden="true"
			{...props}
			style={
				{
					...props.style,
					width: size,
					height: size,
					fontSize: Math.round(size * 0.42),
					"--mark-bg": light.background,
					"--mark-fg": light.text,
					"--mark-bg-dark": dark.background,
					"--mark-fg-dark": dark.text,
				} as CSSProperties
			}
		>
			{letter}
		</span>
	);
}

const styles = stylex.create({
	mark: {
		display: "grid",
		placeItems: "center",
		flexShrink: 0,
		borderRadius: geometry.corner,
		fontFamily: geometry.fontSans,
		fontWeight: 600,
		lineHeight: 1,
		userSelect: "none",
		// --theme-dark is 0 or 1 (styles.css), so each mix resolves to exactly one theme's colour.
		backgroundColor:
			"color-mix(in srgb, var(--mark-bg-dark) calc(var(--theme-dark) * 100%), var(--mark-bg))",
		color:
			"color-mix(in srgb, var(--mark-fg-dark) calc(var(--theme-dark) * 100%), var(--mark-fg))",
		boxShadow: elevation.tileRing,
	},
});
