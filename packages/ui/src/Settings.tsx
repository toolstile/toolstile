import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useId } from "react";
import { layout } from "./Layout.styles";
import { colors, space, text, typeScale } from "./tokens.stylex";

const narrow = "@media (max-width: 760px)";

/**
 * A titled group of settings rows. Sections stack with a shared rhythm on a settings subpage.
 * Use titleHidden when the subpage heading already names the only section; the title stays
 * as the section's accessible name.
 */
export function SettingsSection({
	title,
	description,
	children,
	id,
	titleHidden = false,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
	id?: string;
	titleHidden?: boolean;
}) {
	const generated = useId();
	const headingId = id ?? `settings-${generated}`;
	return (
		<section aria-labelledby={headingId} {...stylex.props(styles.section)}>
			{titleHidden ? (
				<h2 id={headingId} {...stylex.props(layout.visuallyHidden)}>
					{title}
				</h2>
			) : (
				<header {...stylex.props(styles.header)}>
					<h2 id={headingId} {...stylex.props(styles.title)}>
						{title}
					</h2>
					{description ? (
						<p {...stylex.props(styles.description)}>{description}</p>
					) : null}
				</header>
			)}
			<div {...stylex.props(styles.rows, titleHidden && styles.rowsFlush)}>
				{children}
			</div>
		</section>
	);
}

/**
 * One label/control row: a 180px label column and a control column, stacked under 760px.
 * Pass htmlFor to associate the label with a single control.
 */
export function SettingsRow({
	label,
	hint,
	htmlFor,
	children,
}: {
	label: string;
	hint?: ReactNode;
	htmlFor?: string;
	children: ReactNode;
}) {
	return (
		<div {...stylex.props(styles.row)}>
			<div {...stylex.props(styles.labelColumn)}>
				{htmlFor ? (
					<label htmlFor={htmlFor} {...stylex.props(styles.label)}>
						{label}
					</label>
				) : (
					<span {...stylex.props(styles.label)}>{label}</span>
				)}
				{/* A labelled control can point aria-describedby at `${htmlFor}-hint`. */}
				{hint ? (
					<span
						id={htmlFor ? `${htmlFor}-hint` : undefined}
						{...stylex.props(styles.hint)}
					>
						{hint}
					</span>
				) : null}
			</div>
			<div {...stylex.props(styles.control)}>{children}</div>
		</div>
	);
}

const styles = stylex.create({
	section: {
		maxWidth: 760,
		marginBottom: space.s8,
	},
	header: { marginBottom: space.s1 },
	title: {
		margin: 0,
		fontSize: text.sectionTitle,
		lineHeight: text.sectionTitleLeading,
		fontWeight: 600,
	},
	description: {
		margin: `${space.s0_5} 0 0`,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	rows: { marginTop: space.s2 },
	rowsFlush: { marginTop: 0 },
	row: {
		display: "grid",
		gridTemplateColumns: { default: "180px minmax(0, 1fr)", [narrow]: "1fr" },
		gap: { default: space.s4, [narrow]: space.s2 },
		// Labels sit on the first text baseline of the control column.
		alignItems: { default: "baseline", [narrow]: "start" },
		paddingBlock: space.s3,
		// Hairlines only between rows; the page bar or section title already sits above the first.
		borderTopWidth: { default: 1, ":first-child": 0 },
		borderTopStyle: "solid",
		borderTopColor: colors.line,
	},
	labelColumn: {
		display: "grid",
		gap: space.s0_5,
	},
	label: {
		fontWeight: 500,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		color: colors.text,
	},
	hint: {
		color: colors.muted,
		fontSize: typeScale.size12,
		lineHeight: typeScale.leading12,
	},
	control: {
		minWidth: 0,
		display: "grid",
		// Keeps a checkbox and its hint together.
		gap: 6,
		justifyItems: "start",
	},
});
