import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ManagementClient } from "@toolstile/api/client";
import type { Snapshot } from "@toolstile/api/contract";
import { type FormEvent, useState } from "react";
import { CheckboxField } from "./Checkbox";
import { controls } from "./Control.styles";
import { Disclosure } from "./Disclosure";
import { ModalFrame } from "./ModalFrame";
import { colors, space, text, typeScale } from "./tokens.stylex";

/** Statuses a connection reaches only after a completed sign-in. */
const signedIn = new Set(["authenticated", "reachable", "needs reconnection"]);
/**
 * Whether the connection is known to have sign-in that signing in again replaces. Other states,
 * including a host's placeholder for an account it has not checked, leave it to the server,
 * which asks for the confirmation when tokens exist.
 */
function signInReplacesExisting(
	connection: Pick<Snapshot["connections"][number], "status">,
) {
	return signedIn.has(connection.status.trim().toLowerCase());
}

export function UpstreamSignIn({
	connection,
	api,
	onClose,
}: {
	connection: Snapshot["connections"][number] | undefined;
	api: ManagementClient;
	onClose(): void;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	// The server has the final word: it asks when tokens exist that the status did not show.
	const [askReplace, setAskReplace] = useState(false);
	const confirmReplace =
		askReplace || (!!connection && signInReplacesExisting(connection));
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!connection) return;
		const form = new FormData(event.currentTarget);
		setPending(true);
		setError("");
		try {
			const result = await api.startConnectionOAuth({
				id: connection.id,
				clientId: String(form.get("clientId") ?? "").trim() || undefined,
				clientSecret: String(form.get("clientSecret") ?? "") || undefined,
				confirmAccountReplacement:
					confirmReplace && form.get("confirm") === "on",
			});
			window.location.assign(result.url);
		} catch (failure) {
			if (
				!confirmReplace &&
				failure instanceof Error &&
				/confirm replacement/i.test(failure.message)
			) {
				setAskReplace(true);
				setPending(false);
				return;
			}
			setError(
				failure instanceof Error
					? failure.message
					: "MCP sign-in could not start",
			);
			setPending(false);
		}
	}
	return (
		<ModalFrame
			title={`Sign in to ${connection?.label ?? "your MCP"}`}
			description="Continue to the MCP provider to authorize this account"
			closeLabel="Close sign-in dialog"
			width="md"
			onClose={onClose}
		>
			{!connection?.canManageAuthentication ? (
				<p role="alert" {...stylex.props(styles.text)}>
					This connection's sign-in cannot be changed here.
				</p>
			) : (
				<form onSubmit={submit} {...stylex.props(styles.form)}>
					<p {...stylex.props(styles.description)}>
						Signing in does not grant agents access.
					</p>
					<Disclosure summary="Registered client settings (optional)">
						<p {...stylex.props(styles.description, styles.disclosureText)}>
							Some providers require a registered OAuth application. Your
							administrator may have configured one. Enter these settings only
							when using your own registered application.
						</p>
						<label {...stylex.props(controls.label)}>
							Client ID
							<input
								name="clientId"
								maxLength={1024}
								autoComplete="off"
								{...stylex.props(controls.input)}
							/>
						</label>
						<label {...stylex.props(controls.label)}>
							Client secret
							<input
								name="clientSecret"
								type="password"
								maxLength={4096}
								autoComplete="off"
								{...stylex.props(controls.input)}
							/>
						</label>
					</Disclosure>
					{confirmReplace && (
						<CheckboxField name="confirm" required labelStyle={styles.confirm}>
							<span>
								I approve signing in again, replacing this connection's existing
								sign-in.
							</span>
						</CheckboxField>
					)}
					{error ? (
						<p role="alert" {...stylex.props(styles.error)}>
							{error}
						</p>
					) : null}
					<footer {...stylex.props(styles.actions)}>
						<button
							type="button"
							onClick={onClose}
							{...stylex.props(controls.button)}
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={pending}
							{...stylex.props(controls.button, controls.primary)}
						>
							{pending ? "Opening provider…" : "Continue to provider"}
							<ArrowSquareOutIcon />
						</button>
					</footer>
				</form>
			)}
		</ModalFrame>
	);
}
const styles = stylex.create({
	// Block flow: field and disclosure margins collapse into one field gap.
	form: { display: "flow-root" },
	text: { margin: 0, fontSize: text.body, lineHeight: typeScale.leading13 },
	description: {
		margin: 0,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	disclosureText: { marginBlock: 0 },
	confirm: { marginBlock: "var(--field-gap)" },
	// Spacing alone separates the actions; no rule.
	actions: {
		display: "flex",
		justifyContent: "flex-end",
		flexWrap: "wrap",
		gap: space.s2,
		marginTop: space.s4,
	},
	error: {
		margin: 0,
		color: colors.bad,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
});
