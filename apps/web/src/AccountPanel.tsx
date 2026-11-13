import * as stylex from "@stylexjs/stylex";
import type { AccountClient } from "@toolstile/api/client";
import { ConfirmDialog, SettingsRow, SettingsSection } from "@toolstile/ui";
import { controls } from "@toolstile/ui/controls";
import { useLoaded } from "@toolstile/ui/shell";
import { colors, geometry, typeScale } from "@toolstile/ui/tokens.stylex";
import { useEffect, useState } from "react";

const providerNames: Record<string, string> = {
	credential: "Email and password",
	google: "Google",
	github: "GitHub",
};

export function AccountPanel({
	api,
	action,
	onSelect,
}: {
	api: AccountClient;
	action?: "recovery" | "delete";
	onSelect(action?: "recovery" | "delete"): void;
}) {
	const statusLoad = useLoaded<
		Awaited<ReturnType<AccountClient["accountStatus"]>>
	>({
		key: "status",
		load: () => api.accountStatus(),
		failure: "Unable to load account security.",
	});
	const status = statusLoad.latest?.data ?? null;
	const [codes, setCodes] = useState<string[]>([]);
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const shownError = error || statusLoad.current?.error;
	// Reset transient codes when the selected action changes.
	useEffect(() => {
		setCodes([]);
		setError("");
	}, [action]);
	async function rotate() {
		setPending(true);
		setError("");
		try {
			setCodes((await api.rotateRecoveryCodes()).codes);
			statusLoad.set(await api.accountStatus());
		} catch (error) {
			setError(
				error instanceof Error
					? error.message
					: "Unable to create recovery codes.",
			);
		} finally {
			setPending(false);
		}
	}
	async function remove() {
		setPending(true);
		setError("");
		try {
			await api.deleteAccount({ confirmation: "DELETE" });
			location.assign("/auth/recover-account");
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Unable to delete account.",
			);
			setPending(false);
		}
	}
	function download() {
		const url = URL.createObjectURL(
			new Blob(
				[
					`Toolstile recovery codes\nKeep these private. Each code works once.\n\n${codes.join("\n")}\n`,
				],
				{ type: "text/plain" },
			),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "toolstile-recovery-codes.txt";
		link.click();
		URL.revokeObjectURL(url);
	}
	return (
		<SettingsSection
			id="account-security-heading"
			title="Account security"
			titleHidden
		>
			<SettingsRow
				label="Recovery codes"
				hint={status ? `${status.recoveryCodesRemaining} unused` : undefined}
			>
				<p {...stylex.props(styles.text)}>
					Save recovery codes somewhere safe so you can recover without email.
				</p>
				{action === "recovery" ? (
					<div {...stylex.props(styles.detail)}>
						<p {...stylex.props(styles.text)}>
							Creating new codes invalidates all previous codes. Anyone with a
							code can reset your password.
						</p>
						<div {...stylex.props(styles.actions)}>
							<button
								{...stylex.props(controls.button)}
								type="button"
								disabled={pending}
								onClick={rotate}
							>
								{pending ? "Creating…" : "Create new recovery codes"}
							</button>
							<button
								{...stylex.props(controls.button, controls.quiet)}
								type="button"
								onClick={() => onSelect()}
							>
								Close
							</button>
						</div>
						{codes.length > 0 && (
							<>
								<p role="status" {...stylex.props(styles.text)}>
									Save these now. They will disappear when you leave this
									screen.
								</p>
								<pre {...stylex.props(controls.pre, styles.codes)}>
									{codes.join("\n")}
								</pre>
								<button
									{...stylex.props(controls.button)}
									type="button"
									onClick={download}
								>
									Download codes
								</button>
							</>
						)}
					</div>
				) : (
					<button
						{...stylex.props(controls.button)}
						type="button"
						onClick={() => onSelect("recovery")}
					>
						Manage recovery codes
					</button>
				)}
			</SettingsRow>
			{status && status.providers.length > 0 && (
				<SettingsRow label="Sign-in methods">
					<p {...stylex.props(styles.text, styles.value)}>
						{status.providers
							.map((provider) => providerNames[provider] ?? provider)
							.join(", ")}
					</p>
				</SettingsRow>
			)}
			<SettingsRow label="Delete account">
				<p {...stylex.props(styles.text)}>
					Access stops immediately, including agent credentials. Recover within{" "}
					{status?.recoveryWindowDays ?? 7} days using a saved recovery code;
					existing agent credentials remain revoked.
				</p>
				<button
					{...stylex.props(controls.button, controls.danger)}
					type="button"
					onClick={() => onSelect("delete")}
				>
					Delete account
				</button>
				{action === "delete" && (
					<ConfirmDialog
						title="Delete your account?"
						body={`Access stops immediately, including agent credentials. Recover within ${status?.recoveryWindowDays ?? 7} days using a saved recovery code; existing agent credentials remain revoked.`}
						confirmLabel={pending ? "Deleting…" : "Delete my account"}
						confirmation="DELETE"
						busy={pending}
						error={error}
						onConfirm={() => void remove()}
						onCancel={() => onSelect()}
					/>
				)}
			</SettingsRow>
			{shownError && action !== "delete" && (
				<p role="alert" {...stylex.props(styles.error)}>
					{shownError}
				</p>
			)}
		</SettingsSection>
	);
}

const styles = stylex.create({
	text: {
		margin: 0,
		fontSize: typeScale.size13,
		lineHeight: typeScale.leading13,
	},
	value: { color: colors.text },
	actions: { display: "flex", flexWrap: "wrap", gap: 8 },
	detail: { display: "grid", gap: 12, justifyItems: "start", width: "100%" },
	// `controls.pre` supplies the recessed insetTint well; no shadow inside the flat settings row.
	codes: {
		fontFamily: geometry.fontMono,
		userSelect: "all",
		margin: 0,
	},
	error: { color: colors.bad, margin: 0 },
});
