import * as stylex from "@stylexjs/stylex";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useState,
} from "react";
import { AuthFrame, authFrame } from "./AuthFrame";
import { AuthLoading } from "./AuthLoading";
import { controls } from "./Control.styles";
import { CopyValue } from "./CopyValue";
import { colors } from "./tokens.stylex";

type Stage = "loading" | "code" | "approved" | "denied";
type DeviceApprovalSearch = {
	user_code?: string;
	device_name?: string;
	/** Set when the CLI goes on to set up agents itself after the sign-in. */
	next?: "setup";
};
/**
 * The CLI's link fills in its code and machine name, both editable on the page, and says
 * whether the CLI continues with setup on its own. Invalid values are dropped.
 */
export function deviceApprovalSearch(
	search: Record<string, unknown>,
): DeviceApprovalSearch {
	const { user_code, device_name, next } = search;
	return {
		user_code:
			typeof user_code === "string" && user_code.length <= 32
				? user_code
				: undefined,
		device_name:
			typeof device_name === "string" && device_name.length <= 100
				? // oxlint-disable-next-line eslint/no-control-regex -- strip control characters
					device_name.replace(/[\u0000-\u001f\u007f]/g, "").trim()
				: undefined,
		next: next === "setup" ? "setup" : undefined,
	};
}

/** The signed-in account from `/api/auth/get-session`, if the response has one. */
function sessionAccount(session: unknown) {
	if (typeof session !== "object" || session === null || !("user" in session))
		return undefined;
	const { user } = session;
	if (
		typeof user !== "object" ||
		user === null ||
		!("id" in user) ||
		!("email" in user) ||
		typeof user.id !== "string" ||
		typeof user.email !== "string" ||
		!user.id
	)
		return undefined;
	return { id: user.id, email: user.email };
}

/** Shown as XXXX-XXXX; the server accepts any case, with or without the dash. */
function formatCode(value: string) {
	const code = value
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.slice(0, 8);
	return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

async function deviceRequest(
	path: string,
	init: RequestInit & { headers?: Record<string, string> },
) {
	const response = await fetch(path, {
		credentials: "same-origin",
		cache: "no-store",
		...init,
		headers: { "Content-Type": "application/json", ...init.headers },
	});
	const body = (await response.json().catch(() => null)) as {
		status?: string;
		message?: string;
	} | null;
	if (!response.ok)
		throw new Error(
			body?.message ?? "That code did not work. Check it and try again.",
		);
	return body;
}

/**
 * Approve a `toolstile auth login` started on any machine, with no callback URL. The CLI's link
 * fills in the code and the machine's name; the name stays editable and becomes the device its
 * agents are listed under. Approving signs the computer in; setting up its agents is the CLI's
 * next step, which it takes on its own when the link says `next=setup`.
 */
export function DeviceApproval({
	userCode,
	deviceName,
	next,
	footer,
	approvalHeaders,
}: {
	userCode?: string;
	deviceName?: string;
	/** "setup": the CLI continues with `mcp setup` once the code is approved. */
	next?: "setup";
	footer?: ReactNode;
	/** Extra headers for the approval request, read when it is sent. */
	approvalHeaders?: () => Record<string, string>;
}) {
	const id = useId();
	const [stage, setStage] = useState<Stage>("loading");
	const [code, setCode] = useState(formatCode(userCode ?? ""));
	const [device, setDevice] = useState(deviceName ?? "");
	const [pending, setPending] = useState<"approve" | "deny" | null>(null);
	const [error, setError] = useState("");
	const [account, setAccount] = useState<{ id: string; email: string }>();
	const [copyFailed, setCopyFailed] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		fetch("/api/auth/get-session", {
			credentials: "same-origin",
			cache: "no-store",
			signal: controller.signal,
		})
			.then((response) => (response.ok ? response.json() : null))
			.then((session) => {
				if (session) {
					setAccount(sessionAccount(session));
					return setStage("code");
				}
				const returnTo = `${window.location.pathname}${window.location.search}`;
				window.location.replace(
					`/auth/sign-in?${new URLSearchParams({ returnTo })}`,
				);
			})
			.catch(() => {
				if (!controller.signal.aborted) setStage("code");
			});
		return () => controller.abort();
	}, []);

	async function decide(approve: boolean) {
		const value = code.replace("-", "");
		if (value.length !== 8) {
			setError("Enter the 8-character code shown in your terminal.");
			return;
		}
		if (approve && !device.trim()) {
			setError("Name this device.");
			return;
		}
		setPending(approve ? "approve" : "deny");
		setError("");
		try {
			// Every request names the account shown here; the server refuses it for another one.
			if (!account)
				throw new Error(
					"Couldn't check which account is signed in. Reload this page.",
				);
			// The session may have changed in another tab since the page showed the account.
			if (approve) {
				const current = sessionAccount(
					await fetch("/api/auth/get-session", {
						credentials: "same-origin",
						cache: "no-store",
					}).then((response) => (response.ok ? response.json() : null)),
				);
				if (current?.id !== account.id) {
					// Keep the shown account when the session is gone, so a retry checks again.
					if (current) setAccount(current);
					throw new Error(
						current
							? `You are now signed in as ${current.email}. Check the account and approve again.`
							: "You are no longer signed in. Reload this page and sign in.",
					);
				}
			}
			// Looking the code up first binds it to this account; only then can it be decided.
			const status = await deviceRequest("/api/cli/lookup", {
				method: "POST",
				body: JSON.stringify({ userCode: value, accountId: account.id }),
			});
			if (status?.status !== "pending")
				throw new Error(
					"This code was already used. Run toolstile auth login again.",
				);
			// Approval names (or reuses) the device the CLI's agents are listed under.
			await deviceRequest(approve ? "/api/cli/approve" : "/api/cli/deny", {
				method: "POST",
				headers: approve ? approvalHeaders?.() : undefined,
				body: JSON.stringify(
					approve
						? {
								userCode: value,
								accountId: account.id,
								deviceName: device.trim(),
							}
						: { userCode: value, accountId: account.id },
				),
			});
			setStage(approve ? "approved" : "denied");
		} catch (failure) {
			setError(
				failure instanceof Error ? failure.message : "Something went wrong.",
			);
		} finally {
			setPending(null);
		}
	}

	if (stage === "loading")
		return <AuthLoading label="Checking your session…" />;
	return (
		<AuthFrame footer={footer}>
			{stage === "code" ? (
				<form
					aria-labelledby={`${id}-title`}
					onSubmit={(event: FormEvent<HTMLFormElement>) => {
						event.preventDefault();
						void decide(true);
					}}
					{...stylex.props(authFrame.card, s.card)}
				>
					<h1 id={`${id}-title`} {...stylex.props(s.heading)}>
						Sign in to the Toolstile CLI
					</h1>
					<p {...stylex.props(s.description)}>
						Check that the code matches the one{" "}
						<code>
							toolstile {next === "setup" ? "mcp setup" : "auth login"}
						</code>{" "}
						shows in your terminal. Only approve a code you started yourself:
						the CLI can then add and remove agents on that machine for your
						account.
					</p>
					{error && (
						<p role="alert" {...stylex.props(s.error)}>
							{error}
						</p>
					)}
					<label htmlFor={`${id}-code`} {...stylex.props(controls.label)}>
						Code
					</label>
					<input
						id={`${id}-code`}
						name="code"
						required
						autoComplete="off"
						placeholder="XXXX-XXXX"
						autoCapitalize="characters"
						spellCheck={false}
						value={code}
						onChange={(event) => setCode(formatCode(event.target.value))}
						{...stylex.props(controls.input, s.code)}
					/>
					<label htmlFor={`${id}-device`} {...stylex.props(controls.label)}>
						Device name
					</label>
					<input
						id={`${id}-device`}
						name="device"
						required
						maxLength={100}
						autoComplete="off"
						spellCheck={false}
						placeholder="Work laptop"
						value={device}
						onChange={(event) => setDevice(event.target.value)}
						aria-describedby={`${id}-device-hint`}
						{...stylex.props(controls.input)}
					/>
					<p id={`${id}-device-hint`} {...stylex.props(s.hint)}>
						Its agents appear under this name in Devices &amp; agents. An
						existing device with the same name is reused.
					</p>
					{account ? (
						<p {...stylex.props(s.account)}>
							Approving as{" "}
							<span {...stylex.props(s.email)}>{account.email}</span>
						</p>
					) : null}
					<button
						type="submit"
						disabled={pending !== null}
						aria-busy={pending === "approve"}
						{...stylex.props(controls.button, controls.primary, s.target)}
					>
						{pending === "approve" ? "Approving…" : "Approve"}
					</button>
					<button
						type="button"
						disabled={pending !== null}
						aria-busy={pending === "deny"}
						onClick={() => void decide(false)}
						{...stylex.props(controls.button, s.target)}
					>
						{pending === "deny" ? "Denying…" : "Deny"}
					</button>
				</form>
			) : (
				<section
					aria-labelledby={`${id}-done`}
					{...stylex.props(authFrame.card, s.card)}
				>
					<h1 id={`${id}-done`} {...stylex.props(s.heading)}>
						{stage === "approved"
							? `${device.trim()} is signed in`
							: "Sign-in denied"}
					</h1>
					{stage === "denied" ? (
						<p role="status" {...stylex.props(s.description)}>
							The CLI was not signed in. You can close this page.
						</p>
					) : next === "setup" ? (
						<p role="status" {...stylex.props(s.description)}>
							Return to your terminal. It continues with setting up your agents.
							You can close this page.
						</p>
					) : (
						<>
							<p role="status" {...stylex.props(s.description)}>
								Return to your terminal and set up your agents on this computer:
							</p>
							<CopyValue
								value="npx toolstile mcp setup"
								onCopied={() => setCopyFailed(false)}
								onCopyFailed={() => setCopyFailed(true)}
							/>
							{copyFailed ? (
								<p role="alert" {...stylex.props(s.hint, s.copyFailed)}>
									Copy failed. Select the command and copy it.
								</p>
							) : null}
							<p {...stylex.props(s.description)}>You can close this page.</p>
						</>
					)}
				</section>
			)}
		</AuthFrame>
	);
}

const s = stylex.create({
	card: { display: "flex", flexDirection: "column", gap: 20 },
	heading: {
		margin: 0,
		fontSize: 22,
		fontWeight: 600,
		lineHeight: "30px",
		textAlign: "center",
	},
	description: {
		margin: 0,
		color: colors.muted,
		lineHeight: 1.6,
		textAlign: "center",
	},
	error: { margin: 0, color: colors.bad },
	hint: { margin: 0, marginTop: -12, fontSize: 13, color: colors.muted },
	copyFailed: { textAlign: "center" },
	account: {
		margin: 0,
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
		textAlign: "center",
		overflowWrap: "anywhere",
	},
	email: { color: colors.text },
	code: {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
		fontSize: 20,
		letterSpacing: "0.12em",
		textAlign: "center",
	},
	target: { textDecoration: "none" },
});
