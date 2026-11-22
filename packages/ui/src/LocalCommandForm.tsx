import * as stylex from "@stylexjs/stylex";
import type { LocalCommandInput } from "@toolstile/api/contract";
import { type FormEvent, useState } from "react";
import { controls } from "./Control.styles";
import { dashboardStyles } from "./Dashboard.styles";
import { colors, geometry, space, text, typeScale } from "./tokens.stylex";

/** A host that runs local commands (stdio MCP servers) and lets this person add them. */
export interface LocalCommandHost {
	add(input: LocalCommandInput): Promise<{ id: string }>;
}

const lines = (value: string) =>
	value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

/** `NAME=value` lines; the first `=` separates the name, so values may contain more. */
function parseEnvironment(value: string) {
	const env: Record<string, string> = {};
	for (const line of lines(value)) {
		const split = line.indexOf("=");
		if (split <= 0)
			return {
				error: `Write each variable as NAME=value ("${line.slice(0, 40)}" has no name).`,
			};
		env[line.slice(0, split).trim()] = line.slice(split + 1);
	}
	return { env };
}

/**
 * The connection dialog's form for a local command: the program, one argument per line and
 * its environment. Values are sent once and never shown again.
 */
export function LocalCommandForm({
	host,
	onAdded,
	onCancel,
	onUseAddress,
	errorMessage,
}: {
	host: LocalCommandHost;
	/** Runs after the command is saved, with its connection id. */
	onAdded(id: string): Promise<void> | void;
	onCancel(): void;
	/** Switches the dialog back to a remote server address. */
	onUseAddress(): void;
	errorMessage(error: unknown): string;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const fields = new FormData(event.currentTarget);
		const command = String(fields.get("command") ?? "").trim();
		if (!command) {
			setError("Enter the command to run.");
			return;
		}
		const environment = parseEnvironment(String(fields.get("env") ?? ""));
		if (environment.error) {
			setError(environment.error);
			return;
		}
		const label = String(fields.get("label") ?? "").trim();
		setBusy(true);
		setError("");
		let created: { id: string };
		try {
			created = await host.add({
				command,
				args: lines(String(fields.get("args") ?? "")),
				env: environment.env ?? {},
				...(label ? { label } : {}),
			});
		} catch (cause) {
			setError(errorMessage(cause));
			setBusy(false);
			return;
		}
		// The command is saved once its ID returns; what follows never reports a failed add.
		try {
			await onAdded(created.id);
		} finally {
			setBusy(false);
		}
	}
	return (
		<form onSubmit={submit}>
			<p {...stylex.props(dashboardStyles.formDescription, styles.first)}>
				Toolstile starts this MCP server on this computer for each request, as
				the user running Toolstile. Add only commands you trust.{" "}
				<button
					type="button"
					disabled={busy}
					{...stylex.props(styles.textButton)}
					onClick={onUseAddress}
				>
					Use a server address instead
				</button>
			</p>
			<label {...stylex.props(controls.label)}>
				Command
				<input
					{...stylex.props(controls.input, styles.mono)}
					name="command"
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
					maxLength={1024}
					data-autofocus
					placeholder="npx"
				/>
			</label>
			<label {...stylex.props(controls.label)}>
				<span>
					Arguments <span {...stylex.props(controls.optional)}>optional</span>
				</span>
				<textarea
					{...stylex.props(controls.textarea, styles.mono)}
					name="args"
					rows={3}
					autoComplete="off"
					spellCheck={false}
					placeholder={"-y\n@modelcontextprotocol/server-everything"}
					aria-describedby="local-command-args-hint"
				/>
				<span id="local-command-args-hint" {...stylex.props(styles.hint)}>
					One argument per line. Arguments are shown in the dashboard, so put
					keys and tokens in environment variables.
				</span>
			</label>
			<label {...stylex.props(controls.label)}>
				<span>
					Environment variables{" "}
					<span {...stylex.props(controls.optional)}>optional</span>
				</span>
				<textarea
					{...stylex.props(controls.textarea, styles.mono)}
					name="env"
					rows={3}
					autoComplete="off"
					spellCheck={false}
					placeholder="API_KEY=..."
					aria-describedby="local-command-env-hint"
					data-ph-no-capture
				/>
				<span id="local-command-env-hint" {...stylex.props(styles.hint)}>
					One NAME=value per line. Values are stored encrypted and never shown
					again. The command gets only these and PATH, HOME, USER, LOGNAME,
					SHELL and TERM.
				</span>
			</label>
			<label {...stylex.props(controls.label)}>
				<span>
					Name <span {...stylex.props(controls.optional)}>optional</span>
				</span>
				<input
					{...stylex.props(controls.input)}
					name="label"
					maxLength={100}
					autoComplete="off"
					placeholder="Detected from the command"
				/>
			</label>
			{error ? (
				<p role="alert" {...stylex.props(controls.error, styles.error)}>
					{error}
				</p>
			) : null}
			<footer {...stylex.props(dashboardStyles.modalActions)}>
				<button
					{...stylex.props(controls.button)}
					type="button"
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					type="submit"
					{...stylex.props(controls.button, controls.primary)}
					disabled={busy}
				>
					{busy ? "Starting…" : "Add command"}
				</button>
			</footer>
		</form>
	);
}

const styles = stylex.create({
	first: { marginTop: 0 },
	mono: { fontFamily: geometry.fontMono, fontSize: text.meta },
	hint: {
		color: colors.muted,
		fontWeight: 400,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	error: { margin: `${space.s2} 0 0` },
	textButton: {
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: colors.action,
		fontSize: "inherit",
		fontFamily: "inherit",
		lineHeight: typeScale.leading13,
		fontWeight: 500,
		cursor: "pointer",
		textDecoration: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
		},
	},
});
