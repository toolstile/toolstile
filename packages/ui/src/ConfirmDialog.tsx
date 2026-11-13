import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import { controls } from "./Control.styles";
import { ModalFrame } from "./ModalFrame";
import { colors, space, text } from "./tokens.stylex";

/**
 * Confirmation for a destructive action, in place of the browser's native confirm. The caller
 * keeps it open in local state and closes it after `onConfirm` settles; Escape, the backdrop
 * and Cancel ask through `onCancel`, and all three wait while `busy`. Focus starts on Cancel,
 * or on the typed confirmation field when `confirmation` asks for one.
 */
export function ConfirmDialog({
	title,
	body,
	confirmLabel,
	busy = false,
	confirmation,
	error,
	onConfirm,
	onCancel,
}: {
	title: string;
	body: string;
	confirmLabel: string;
	busy?: boolean;
	/** A word, such as DELETE, that must be typed before the action is enabled. */
	confirmation?: string;
	/** Failure of the last attempt, shown inside the dialog. */
	error?: string;
	onConfirm(): void;
	onCancel(): void;
}) {
	const bodyId = useId();
	const fieldId = useId();
	const [typed, setTyped] = useState("");
	const ready = !confirmation || typed === confirmation;
	return (
		<ModalFrame
			title={title}
			describedBy={bodyId}
			busy={busy}
			width="sm"
			onClose={onCancel}
		>
			<form
				{...stylex.props(local.frame)}
				onSubmit={(event) => {
					event.preventDefault();
					if (ready && !busy) onConfirm();
				}}
			>
				<p id={bodyId} {...stylex.props(local.body)}>
					{body}
				</p>
				{confirmation ? (
					<label htmlFor={fieldId} {...stylex.props(controls.label)}>
						Type {confirmation} to confirm
						<input
							id={fieldId}
							data-autofocus
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							disabled={busy}
							autoComplete="off"
							spellCheck={false}
							{...stylex.props(controls.input)}
						/>
					</label>
				) : null}
				{error ? (
					<p role="alert" {...stylex.props(local.error)}>
						{error}
					</p>
				) : null}
				<div {...stylex.props(local.actions)}>
					<button
						type="button"
						data-autofocus={confirmation ? undefined : true}
						{...stylex.props(controls.button)}
						disabled={busy}
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						type="submit"
						{...stylex.props(controls.button, controls.destructive)}
						disabled={busy || !ready}
					>
						{confirmLabel}
					</button>
				</div>
			</form>
		</ModalFrame>
	);
}

const local = stylex.create({
	frame: { display: "flex", flexDirection: "column", gap: space.s4 },
	body: {
		margin: 0,
		color: colors.text,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		overflowWrap: "anywhere",
	},
	error: {
		margin: 0,
		color: colors.bad,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	actions: {
		display: "flex",
		justifyContent: "flex-end",
		flexWrap: "wrap",
		gap: space.s2,
	},
});
