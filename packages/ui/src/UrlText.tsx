import * as stylex from "@stylexjs/stylex";
import { colors, geometry, typeScale } from "./tokens.stylex";

/** Monospace URL without an https scheme, host emphasised and path muted; `muted` quiets the host too. */
export function UrlText({
	url,
	muted = false,
}: {
	url: string;
	muted?: boolean;
}) {
	let parts: { scheme: string; host: string; rest: string } | null = null;
	try {
		const parsed = new URL(url);
		const scheme = `${parsed.protocol}//`;
		const start = url.indexOf(parsed.host, scheme.length - 2);
		if (parsed.host && start >= 0)
			parts = {
				scheme: url.slice(0, start),
				host: url.slice(start, start + parsed.host.length),
				rest: url.slice(start + parsed.host.length),
			};
	} catch {}
	return (
		<code title={url} {...stylex.props(styles.url, muted && styles.muted)}>
			{parts ? (
				<>
					{/* https is implied and hidden; any other scheme stays visible. The full address is in the title. */}
					{parts.scheme === "https://" ? null : (
						<span {...stylex.props(styles.muted)}>{parts.scheme}</span>
					)}
					<span {...stylex.props(!muted && styles.host)}>{parts.host}</span>
					<span {...stylex.props(styles.muted)}>{parts.rest}</span>
				</>
			) : (
				url
			)}
		</code>
	);
}

const styles = stylex.create({
	url: {
		fontFamily: geometry.fontMono,
		fontSize: typeScale.size12,
		lineHeight: typeScale.leading12,
		overflowWrap: "anywhere",
	},
	muted: { color: colors.muted },
	host: { color: colors.text },
});
