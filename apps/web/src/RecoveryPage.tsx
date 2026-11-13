import * as stylex from "@stylexjs/stylex";
import { useSearch } from "@tanstack/react-router";
import { AuthFrame, authFrame, Notice } from "@toolstile/ui";
import { accountAuthHref } from "@toolstile/ui/account-navigation";
import { controls } from "@toolstile/ui/controls";
import { colors, text } from "@toolstile/ui/tokens.stylex";
import { type FormEvent, useState } from "react";

export function RecoveryPage() {
	const context = useSearch({ from: "/auth" });
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [pending, setPending] = useState(false);
	async function recover(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError("");
		setNotice("");
		setPending(true);
		const formElement = event.currentTarget;
		const form = new FormData(formElement);
		try {
			const response = await fetch("/api/auth/recover-account", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(Object.fromEntries(form)),
			});
			if (!response.ok)
				throw new Error(
					"The recovery code is invalid or recovery is unavailable. Check your details and try again.",
				);
			formElement.reset();
			setNotice(
				"Your password has been reset. Sign in with your new password. Previous sessions and agent credentials remain revoked.",
			);
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Unable to recover account.",
			);
		} finally {
			setPending(false);
		}
	}
	return (
		<AuthFrame>
			<section
				aria-labelledby="recover-title"
				{...stylex.props(authFrame.card)}
			>
				<h1 id="recover-title" {...stylex.props(styles.heading)}>
					Recover your account
				</h1>
				<p {...stylex.props(styles.description)}>
					Use a saved recovery code or a one-use code issued through the secure
					recovery procedure. A deleted account can be recovered only before its
					recovery window ends.
				</p>
				<form onSubmit={recover}>
					<label {...stylex.props(controls.label)}>
						Email
						<input
							{...stylex.props(controls.input)}
							name="identifier"
							type="email"
							autoComplete="username"
							defaultValue={context.email}
							required
						/>
					</label>
					<label {...stylex.props(controls.label)}>
						Recovery code
						<input
							{...stylex.props(controls.input)}
							name="code"
							autoComplete="off"
							type="password"
							required
							maxLength={200}
						/>
					</label>
					<label {...stylex.props(controls.label)}>
						New password
						<input
							{...stylex.props(controls.input)}
							name="password"
							type="password"
							autoComplete="new-password"
							required
							minLength={12}
							maxLength={128}
						/>
					</label>
					{(notice || error) && (
						<div {...stylex.props(styles.notice)}>
							{notice ? (
								<Notice>{notice}</Notice>
							) : (
								<Notice error>{error}</Notice>
							)}
						</div>
					)}
					<button
						type="submit"
						disabled={pending}
						aria-busy={pending}
						{...stylex.props(controls.button, controls.primary, styles.submit)}
					>
						{pending ? "Recovering…" : "Reset password"}
					</button>
				</form>
				<p {...stylex.props(styles.back)}>
					<a
						href={accountAuthHref("sign-in", context)}
						{...stylex.props(styles.link)}
					>
						Back to sign in
					</a>
				</p>
			</section>
		</AuthFrame>
	);
}
const styles = stylex.create({
	heading: {
		margin: 0,
		textAlign: "center",
		fontSize: text.pageTitle,
		lineHeight: text.pageTitleLeading,
		letterSpacing: "-0.01em",
		fontWeight: 600,
	},
	description: {
		margin: "8px 0 12px",
		color: colors.muted,
		textAlign: "center",
	},
	notice: { marginBlock: 12 },
	submit: { width: "100%", marginTop: 8, fontWeight: 600 },
	back: { margin: "20px 0 0", textAlign: "center" },
	link: {
		display: "inline-flex",
		alignItems: "center",
		minHeight: { default: 0, "@media (pointer: coarse)": 44 },
		color: colors.action,
		fontWeight: 500,
		textDecoration: { default: "none", ":hover": "underline" },
		textUnderlineOffset: 3,
	},
});
