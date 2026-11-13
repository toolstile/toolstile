import { CopyIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { AgentStep } from "./agent-clients";
import { controls } from "./Control.styles";
import { layout } from "./Layout.styles";
import { colors, geometry, space, text, typeScale } from "./tokens.stylex";

/**
 * Numbered connect steps. Each command, file or URL sits in its own well with a copy button;
 * one status line announces the last copy.
 */
export function AgentSteps({
	steps,
	autoFocus = false,
}: {
	steps: AgentStep[];
	/** Focuses the first copy button when a dialog opens on these steps. */
	autoFocus?: boolean;
}) {
	// The copied text, not only its position, so another app's steps never show "Copied".
	const [copied, setCopied] = useState<{
		code: string;
		result: "copied" | "failed";
	} | null>(null);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(null), 2500);
		return () => clearTimeout(timer);
	}, [copied]);
	const firstCode = steps.findIndex((step) => step.code !== undefined);
	return (
		<>
			<ol {...stylex.props(styles.list)}>
				{steps.map((step, index) => (
					<li key={step.text} {...stylex.props(styles.step)}>
						<span aria-hidden="true" {...stylex.props(styles.number)}>
							{index + 1}
						</span>
						<div {...stylex.props(styles.content)}>
							<p {...stylex.props(styles.text)}>{step.text}</p>
							{step.code !== undefined ? (
								<div {...stylex.props(styles.snippet)}>
									<pre {...stylex.props(styles.code)}>{step.code}</pre>
									<button
										type="button"
										aria-label={`Copy ${step.codeKind ?? "text"}`}
										data-autofocus={
											(autoFocus && index === firstCode) || undefined
										}
										{...stylex.props(
											controls.button,
											controls.small,
											styles.copy,
										)}
										onClick={() =>
											Promise.resolve()
												.then(() =>
													navigator.clipboard.writeText(step.code ?? ""),
												)
												.then(
													() =>
														setCopied({
															code: step.code ?? "",
															result: "copied",
														}),
													() =>
														setCopied({
															code: step.code ?? "",
															result: "failed",
														}),
												)
										}
									>
										<CopyIcon size={16} aria-hidden="true" />
										{copied?.code === step.code && copied.result === "copied"
											? "Copied"
											: "Copy"}
									</button>
								</div>
							) : null}
						</div>
					</li>
				))}
			</ol>
			<p role="status" {...stylex.props(layout.visuallyHidden)}>
				{copied?.result === "copied"
					? "Copied to clipboard"
					: copied?.result === "failed"
						? "Copy failed. Select the text and copy it manually."
						: ""}
			</p>
		</>
	);
}

const coarse = "@media (pointer: coarse)";

const styles = stylex.create({
	list: {
		listStyle: "none",
		margin: 0,
		padding: 0,
		display: "grid",
		gap: space.s3,
		minWidth: 0,
	},
	step: {
		display: "grid",
		gridTemplateColumns: "20px minmax(0, 1fr)",
		columnGap: space.s3,
		minWidth: 0,
	},
	number: {
		width: 20,
		height: 20,
		marginTop: 1,
		borderRadius: "50%",
		display: "grid",
		placeItems: "center",
		backgroundColor: colors.insetTint,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: typeScale.leading12,
		fontWeight: 500,
		fontVariantNumeric: "tabular-nums",
	},
	content: { display: "grid", gap: space.s2, minWidth: 0 },
	text: {
		margin: 0,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	snippet: { position: "relative", minWidth: 0 },
	// One line of code centres beside the copy button: 40px, or 56px around a 44px coarse target.
	code: {
		display: "block",
		margin: 0,
		paddingBlock: { default: 11, [coarse]: 19 },
		paddingInlineStart: space.s3,
		paddingInlineEnd: 88,
		minHeight: { default: 40, [coarse]: 56 },
		borderRadius: geometry.corner,
		backgroundColor: colors.insetTint,
		color: colors.text,
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere",
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		lineHeight: typeScale.leading12,
	},
	copy: { position: "absolute", top: 6, insetInlineEnd: 6 },
});
