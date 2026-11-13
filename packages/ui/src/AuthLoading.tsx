import * as stylex from "@stylexjs/stylex";
import { Brand } from "./Brand";
import { controls } from "./Control.styles";
import { colors, typeScale } from "./tokens.stylex";

/** Authentication is resolved before any account navigation or private content is shown. */
export function AuthLoading({
	label = "Loading…",
	error,
	onRetry,
}: {
	label?: string;
	error?: string;
	onRetry?(): void;
}) {
	return (
		<main aria-busy={!error} {...stylex.props(styles.page)}>
			<div {...stylex.props(styles.content)}>
				<Brand />
				{error ? (
					<>
						<p role="alert" {...stylex.props(styles.message)}>
							{error}
						</p>
						{onRetry && (
							<button
								type="button"
								onClick={onRetry}
								{...stylex.props(controls.button, controls.large)}
							>
								Try again
							</button>
						)}
					</>
				) : (
					<p role="status" {...stylex.props(styles.status)}>
						<span aria-hidden="true" {...stylex.props(styles.indicator)} />
						{label}
					</p>
				)}
			</div>
		</main>
	);
}
const pulse = stylex.keyframes({
	"0%, 100%": { opacity: 0.35 },
	"50%": { opacity: 1 },
});
const styles = stylex.create({
	page: {
		minHeight: "100dvh",
		display: "grid",
		placeItems: "center",
		padding: 24,
		backgroundColor: colors.page,
		color: colors.text,
	},
	content: {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		gap: 20,
		maxWidth: 360,
		textAlign: "center",
	},
	status: {
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		margin: 0,
		fontSize: typeScale.size14,
		color: colors.muted,
	},
	message: { margin: 0, fontSize: typeScale.size14, color: colors.muted },
	indicator: {
		width: 6,
		height: 6,
		borderRadius: "50%",
		backgroundColor: colors.action,
		animationName: pulse,
		animationDuration: "1.4s",
		animationTimingFunction: "ease-in-out",
		animationIterationCount: "infinite",
		"@media (prefers-reduced-motion: reduce)": { animationName: "none" },
	},
});
