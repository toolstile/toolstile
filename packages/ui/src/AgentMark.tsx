import * as stylex from "@stylexjs/stylex";
import { detectAgentClient } from "./agent-clients";
import { agentMarks, monochromeMarks } from "./assets/agents";
import { ConnectionMark } from "./ConnectionMark";
import type { SetupClient } from "./setup-contract";
import { colors } from "./tokens.stylex";

/** An agent app's mark in a logo tile. Decorative; the app's name is always shown beside it. */
export function AppMark({
	client,
	size = 28,
}: {
	client: SetupClient;
	size?: number;
}) {
	return (
		<span aria-hidden="true" {...stylex.props(styles.tile, styles.size(size))}>
			<img
				src={agentMarks[client]}
				alt=""
				width={Math.round(size * 0.64)}
				height={Math.round(size * 0.64)}
				{...stylex.props(
					styles.image,
					monochromeMarks.has(client) && styles.mono,
				)}
			/>
		</span>
	);
}

/**
 * An agent's tile: its app's mark when the name identifies a known agent app, otherwise the
 * letter tile used for connections. Decorative; the agent's name is always shown beside it.
 */
export function AgentMark({
	label,
	size = 28,
}: {
	label: string;
	size?: number;
}) {
	const client = detectAgentClient(label);
	if (!client) return <ConnectionMark label={label} url="" size={size} />;
	return <AppMark client={client} size={size} />;
}

const styles = stylex.create({
	// White in light; the raised dark tile in dark, matching connector logos.
	tile: {
		display: "inline-grid",
		placeItems: "center",
		flexShrink: 0,
		boxSizing: "border-box",
		backgroundColor:
			"color-mix(in srgb, #1c2029 calc(var(--theme-dark) * 100%), #fff)",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: colors.line,
		borderRadius: 6,
	},
	size: (value: number) => ({ width: value, height: value }),
	image: { display: "block", objectFit: "contain" },
	// Black marks invert on the dark tile.
	mono: { filter: "invert(calc(var(--theme-dark) * 0.92))" },
});
