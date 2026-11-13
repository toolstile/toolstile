import { CheckIcon, XIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { Tooltip } from "./Tooltip";
import { colors } from "./tokens.stylex";

/**
 * In-place name editor that keeps the name's font, position and line box, so nothing around it
 * moves. The field grows with its text, and the check sits where the rename pencil was. Enter,
 * the check or leaving the editor saves; Escape or the cross cancels. The field takes focus when
 * it opens; the caller restores focus to the row once it closes.
 */
export function InlineRename({
	label,
	fieldLabel,
	busy,
	onSave,
	onCancel,
}: {
	label: string;
	/** Accessible name of the text field, such as "Device name". */
	fieldLabel: string;
	busy: boolean;
	onSave(label: string): void;
	onCancel(): void;
}) {
	const root = useRef<HTMLSpanElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(label);
	// Escape and Enter also blur the field as it unmounts; only the first ending counts.
	const ended = useRef(false);
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			input.current?.focus();
			input.current?.select();
		});
		return () => cancelAnimationFrame(frame);
	}, []);
	function save() {
		if (busy || ended.current) return;
		const next = value.trim();
		ended.current = true;
		if (!next || next === label) onCancel();
		else onSave(next);
	}
	function cancel() {
		if (ended.current) return;
		ended.current = true;
		onCancel();
	}
	// Keeps focus in the field on click, so its blur does not save before Cancel runs.
	function keepFocus(event: MouseEvent) {
		event.preventDefault();
	}
	return (
		<span ref={root} {...stylex.props(styles.root)}>
			{/* The hidden copy of the text sizes the grid cell, and the field fills it. */}
			<span {...stylex.props(styles.sizer)}>
				<span aria-hidden="true" {...stylex.props(styles.text, styles.mirror)}>
					{value || " "}
				</span>
				<input
					ref={input}
					aria-label={fieldLabel}
					// oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- aria-description is valid ARIA 1.3; the rule data predates it.
					aria-description="Enter to save, Escape to cancel"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					// The smallest intrinsic width, so the hidden copy alone decides the size.
					size={1}
					required
					maxLength={100}
					readOnly={busy}
					onBlur={(event) => {
						// Moving to Save or Cancel is not leaving the editor.
						if (root.current?.contains(event.relatedTarget)) return;
						save();
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							save();
						} else if (event.key === "Escape") {
							event.preventDefault();
							cancel();
						}
					}}
					{...stylex.props(styles.text, styles.input)}
				/>
			</span>
			<Tooltip label="Save">
				<button
					type="button"
					aria-label="Save"
					disabled={busy}
					onClick={save}
					onMouseDown={keepFocus}
					{...stylex.props(styles.icon, styles.save)}
				>
					<CheckIcon size={12} weight="bold" aria-hidden="true" />
				</button>
			</Tooltip>
			<Tooltip label="Cancel">
				<button
					type="button"
					aria-label="Cancel"
					disabled={busy}
					onClick={cancel}
					onMouseDown={keepFocus}
					{...stylex.props(styles.icon)}
				>
					<XIcon size={12} weight="bold" aria-hidden="true" />
				</button>
			</Tooltip>
		</span>
	);
}

const styles = stylex.create({
	root: {
		display: "inline-flex",
		alignItems: "center",
		maxWidth: "100%",
		minWidth: 0,
		verticalAlign: "top",
	},
	sizer: {
		display: "inline-grid",
		minWidth: "2ch",
		maxWidth: "100%",
		// Pulls the field's padding outside the text, so the text keeps its place.
		marginBlock: -2,
		marginInlineStart: -4,
	},
	// Shared by the field and its hidden copy, so both measure the same.
	text: {
		gridArea: "1 / 1",
		minWidth: 0,
		paddingBlock: 2,
		paddingInline: 4,
		fontFamily: "inherit",
		fontSize: "inherit",
		fontWeight: "inherit",
		lineHeight: "inherit",
		letterSpacing: "inherit",
	},
	mirror: { visibility: "hidden", whiteSpace: "pre", overflow: "hidden" },
	// A quiet recessed well: a faint fill and a soft inner shadow, no border or focus outline.
	input: {
		width: "100%",
		margin: 0,
		borderStyle: "none",
		borderRadius: 4,
		outline: "none",
		backgroundColor: colors.insetTint,
		boxShadow: `inset 0 1px 2px color-mix(in srgb, ${colors.text} 14%, transparent)`,
		color: colors.text,
	},
	// 20px icon buttons. The save button's box starts 4px clear of the field, which puts its
	// 12px check where the rename pencil sat (12px after the text).
	icon: {
		display: "grid",
		placeItems: "center",
		flexShrink: 0,
		width: 20,
		height: 20,
		marginBlock: -2,
		padding: 0,
		borderStyle: "none",
		borderRadius: 4,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		cursor: { default: "pointer", ":disabled": "not-allowed" },
	},
	save: {
		marginInlineStart: 4,
		color: {
			default: colors.action,
			":hover": colors.action,
			":focus-visible": colors.action,
		},
	},
});
