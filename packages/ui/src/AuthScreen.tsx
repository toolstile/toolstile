import {
	CircleNotchIcon,
	EyeIcon,
	EyeSlashIcon,
	GithubLogoIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import {
	type FocusEvent,
	type FormEvent,
	type InputHTMLAttributes,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { safeLocalReturnTo } from "./AccountNavigation";
import {
	accountSocialErrorCallback,
	authFailure,
	callbackAuthFailure,
	readAuthResponse,
} from "./AuthFeedback";
import { AuthFrame, authFrame } from "./AuthFrame";
import { AuthLoading } from "./AuthLoading";
import { oauthQueryWithoutPresentation } from "./AuthNavigation";
import { controls } from "./Control.styles";
import { Notice } from "./Primitives";
import { colors, geometry, motion, size, text } from "./tokens.stylex";

type Field = "name" | "email" | "password" | "invitationToken";

/** Mirrors the server rules (packages/auth: 12–128 character passwords on sign-up). */
function fieldError(field: Field, value: string, signup: boolean) {
	if (field === "name") {
		if (!value.trim()) return "Enter the name to show on your account.";
		return value.length > 100 ? "Use 100 characters or fewer." : "";
	}
	if (field === "email") {
		if (!value.trim()) return "Enter your email address.";
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
			? ""
			: "Enter an email address like name@example.com.";
	}
	if (field === "password") {
		if (!value) return "Enter your password.";
		if (signup && !value.trim())
			return "Use letters, numbers or symbols. A password of only spaces is not allowed.";
		if (signup && value.length < 12)
			return `Use at least 12 characters (${12 - value.length} more).`;
		if (value.length > 128) return "Use 128 characters or fewer.";
		return "";
	}
	return value.trim() ? "" : "Enter the invitation token you were given.";
}

export function AuthScreen({
	onReady,
	mode,
	onModeChange,
	registrationOpen = false,
	recoveryHref,
	callbackURL,
	modeHref,
	initialEmail,
	invitationToken: providedInvitationToken,
	legal,
	footer,
	alternativeMethods,
}: {
	onReady(): void;
	mode: "signin" | "signup";
	onModeChange(mode: "signin" | "signup", email?: string): void;
	registrationOpen?: boolean;
	recoveryHref?: string;
	/** Root-relative post-auth page; omitted for embedded, signed authorization flows. */
	callbackURL?: string;
	modeHref?: string;
	initialEmail?: string;
	invitationToken?: string;
	/** Agreement line shown under the create-account button. */
	legal?: ReactNode;
	/** Passed to AuthFrame as the quiet line under the form; left out when `legal` already shows. */
	footer?: ReactNode;
	/** Additional authentication choices rendered with the form on every viewport. */
	alternativeMethods?: ReactNode;
}) {
	const [error, setError] = useState(() =>
			typeof window !== "undefined" &&
			new URLSearchParams(window.location.search).has("error")
				? callbackAuthFailure(
						new URLSearchParams(window.location.search).get("error"),
						!!recoveryHref,
					)
				: "",
		),
		[pending, setPending] = useState(false);
	const [fieldErrors, setFieldErrors] = useState<
		Partial<Record<Field, string>>
	>({});
	const [passwordVisible, setPasswordVisible] = useState(false);
	const [passwordLength, setPasswordLength] = useState(0);
	const params =
		typeof window === "undefined"
			? new URLSearchParams()
			: new URLSearchParams(window.location.search);
	const signup = mode === "signup";
	const [providers, setProviders] = useState<("github" | "google")[]>([]);
	const [optionsSettled, setOptionsSettled] = useState(false);
	const [optionsState, setOptionsState] = useState<
		"loading" | "ready" | "error"
	>("loading");
	const [optionsAttempt, setOptionsAttempt] = useState(0);
	const [pendingMethod, setPendingMethod] = useState("");
	const requestInFlight = useRef(false);
	const errorRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (error && optionsSettled) errorRef.current?.focus();
	}, [error, optionsSettled]);
	const [acceptedInvitation, setAcceptedInvitation] = useState(false);
	const [invitationEmail, setInvitationEmail] = useState<string>();
	const formRef = useRef<HTMLFormElement>(null);
	const submitRef = useRef<HTMLButtonElement>(null);
	const id = useId();
	// the attempt counter explicitly retries discovery.
	useEffect(() => {
		const controller = new AbortController();
		const timeout = window.setTimeout(() => {
			controller.abort();
			setOptionsState("error");
			setOptionsSettled(true);
		}, 8000);
		setOptionsState("loading");
		fetch("/api/auth/account-options", { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error("Options unavailable");
				return response.json();
			})
			.then((options) => {
				if (controller.signal.aborted) return;
				if (!Array.isArray(options?.providers))
					throw new Error("Options unavailable");
				window.clearTimeout(timeout);
				setOptionsState("ready");
				setOptionsSettled(true);
				if (callbackURL !== undefined && options?.invitation) {
					setAcceptedInvitation(true);
					if (typeof options.invitation.email === "string")
						setInvitationEmail(options.invitation.email);
				}
				if (!controller.signal.aborted && Array.isArray(options?.providers))
					setProviders(
						options.providers.filter(
							(provider: unknown) =>
								provider === "github" || provider === "google",
						),
					);
			})
			.catch(() => {
				window.clearTimeout(timeout);
				if (!controller.signal.aborted) {
					setOptionsState("error");
					setOptionsSettled(true);
				}
			});
		return () => {
			window.clearTimeout(timeout);
			controller.abort();
		};
	}, [callbackURL, optionsAttempt]);
	useEffect(() => {
		const restore = (event: PageTransitionEvent) => {
			if (!event.persisted) return;
			requestInFlight.current = false;
			setPending(false);
		};
		window.addEventListener("pageshow", restore);
		// Only ordinary account pages consume callback presentation state.
		const url = new URL(window.location.href);
		if (
			callbackURL !== undefined &&
			!url.searchParams.has("sig") &&
			url.searchParams.has("error")
		) {
			url.searchParams.delete("error");
			url.searchParams.delete("error_description");
			window.history.replaceState(
				window.history.state,
				"",
				url.pathname + url.search + url.hash,
			);
		}
		return () => window.removeEventListener("pageshow", restore);
	}, [callbackURL]);

	// Field rules differ between modes; stale messages would describe the other form.
	const [shownMode, setShownMode] = useState(mode);
	if (shownMode !== mode) {
		setShownMode(mode);
		setFieldErrors({});
		setError("");
	}
	async function signInWith(provider: "github" | "google") {
		if (requestInFlight.current) return;
		requestInFlight.current = true;
		setPendingMethod(provider === "google" ? "Google" : "GitHub");
		setPending(true);
		setError("");
		try {
			const callback = new URL(location.href);
			callback.search = oauthQueryWithoutPresentation(location.search);
			if (!params.has("sig")) {
				callback.searchParams.delete("invite");
				callback.searchParams.delete("email");
			}
			if (callbackURL !== undefined) {
				const target = new URL(safeLocalReturnTo(callbackURL), location.origin);
				callback.href = target.href;
			}
			const invitationToken =
				providedInvitationToken ??
				params.get("invite") ??
				String(
					formRef.current
						? (new FormData(formRef.current).get("invitationToken") ?? "")
						: "",
				);
			const response = await fetch("/api/auth/sign-in/social", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					provider,
					callbackURL: callback.href,
					...(accountSocialErrorCallback(location.href, callbackURL)
						? {
								errorCallbackURL: accountSocialErrorCallback(
									location.href,
									callbackURL,
								),
							}
						: {}),
					...(invitationToken ? { additionalData: { invitationToken } } : {}),
				}),
			});
			const result = await readAuthResponse(response);
			if (!response.ok || typeof result.url !== "string")
				throw new Error(
					authFailure(result.code ?? result.message, "social", {
						recovery: !!recoveryHref,
					}),
				);
			const destination = new URL(result.url);
			if (!["https:", "http:"].includes(destination.protocol))
				throw new Error(authFailure(undefined, "social"));
			location.assign(destination.href);
		} catch (error) {
			setError(
				error instanceof TypeError
					? "Could not connect. Check your connection and try again."
					: error instanceof Error
						? error.message
						: "Sign-in could not start. Try again.",
			);
			setPending(false);
			requestInFlight.current = false;
		}
	}
	function check(input: HTMLInputElement, force: boolean) {
		const field = input.name as Field;
		// Leaving an untouched field empty is not an error until the form is submitted.
		if (!force && !input.value && !fieldErrors[field]) return "";
		const message = fieldError(field, input.value, signup);
		setFieldErrors((current) =>
			current[field] === message ? current : { ...current, [field]: message },
		);
		return message;
	}
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (requestInFlight.current) return;
		const form = event.currentTarget;
		const invalid = [...form.querySelectorAll<HTMLInputElement>("input[name]")]
			.map((input) => ({ input, message: check(input, true) }))
			.filter(({ message }) => message);
		if (invalid.length) {
			invalid[0].input.focus();
			return;
		}
		requestInFlight.current = true;
		setPendingMethod("email");
		setPending(true);
		setError("");
		const data = Object.fromEntries(new FormData(form));
		try {
			const response = await fetch(
				`/api/auth/${signup ? "sign-up" : "sign-in"}/email`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						...data,
						email: String(data.email ?? "").trim(),
						invitationToken:
							providedInvitationToken ??
							params.get("invite") ??
							data.invitationToken,
						...(callbackURL !== undefined
							? { callbackURL: safeLocalReturnTo(callbackURL) }
							: {}),
					}),
				},
			);
			const result = await readAuthResponse(response);
			if (!response.ok || !result.user || typeof result.user !== "object")
				throw new Error(
					authFailure(
						result.code ?? result.message,
						signup ? "signup" : "signin",
						{
							recovery: !!recoveryHref,
							invitationRequired: signup && !registrationOpen,
						},
					),
				);
			if (signup && !params.has("sig")) {
				const clean = new URL(window.location.href);
				clean.searchParams.delete("invite");
				clean.searchParams.delete("email");
				window.history.replaceState(
					window.history.state,
					"",
					clean.pathname + clean.search,
				);
			}
			onReady();
		} catch (e) {
			setError(
				e instanceof TypeError
					? "Could not connect. Check your connection and try again."
					: e instanceof Error
						? e.message
						: "Sign-in did not complete. Try again.",
			);
			setPending(false);
			requestInFlight.current = false;
		}
	}
	/** Phones: once the keyboard has opened, keep the focused field and the submit button visible. */
	function keepInView(event: FocusEvent<HTMLFormElement>) {
		const target = event.target;
		if (
			!(target instanceof HTMLInputElement) ||
			!window.matchMedia("(max-width: 899px)").matches
		)
			return;
		const behavior = window.matchMedia("(prefers-reduced-motion: reduce)")
			.matches
			? "auto"
			: "smooth";
		window.setTimeout(() => {
			if (document.activeElement !== target) return;
			submitRef.current?.scrollIntoView({ block: "nearest", behavior });
			target.scrollIntoView({ block: "nearest", behavior });
		}, 300);
	}
	const field = (
		name: Field,
		label: string,
		input: InputHTMLAttributes<HTMLInputElement>,
		trailing?: ReactNode,
		/** Requirement beside the label, so the rule is known before any error. */
		hint?: ReactNode,
		/** Link beside the label; it follows the input in tab order. */
		action?: ReactNode,
	) => {
		const message = fieldErrors[name];
		const errorId = `${id}-${name}-error`;
		const hintId = `${id}-${name}-hint`;
		return (
			<div {...stylex.props(authStyles.field)}>
				<label htmlFor={`${id}-${name}`} {...stylex.props(authStyles.label)}>
					{label}
				</label>
				{hint && (
					<span id={hintId} {...stylex.props(authStyles.aside)}>
						{hint}
					</span>
				)}
				<div {...stylex.props(authStyles.inputWrap)}>
					<input
						key={name === "password" ? mode : name}
						id={`${id}-${name}`}
						name={name}
						readOnly={pending}
						aria-invalid={message ? true : undefined}
						aria-describedby={
							[message && errorId, hint && hintId].filter(Boolean).join(" ") ||
							undefined
						}
						onBlur={(event) => check(event.currentTarget, false)}
						onChange={(event) => {
							if (name === "password")
								setPasswordLength(event.currentTarget.value.length);
							if (fieldErrors[name]) check(event.currentTarget, true);
						}}
						{...input}
						{...stylex.props(
							controls.input,
							authStyles.input,
							trailing ? authStyles.inputWithToggle : null,
							message ? authStyles.inputInvalid : null,
						)}
					/>
					{trailing}
				</div>
				{action && <span {...stylex.props(authStyles.aside)}>{action}</span>}
				{message && (
					<p id={errorId} {...stylex.props(authStyles.fieldError)}>
						<WarningCircleIcon
							size={16}
							weight="fill"
							aria-hidden="true"
							{...stylex.props(authStyles.fieldErrorIcon)}
						/>
						{message}
					</p>
				)}
			</div>
		);
	};
	const switchLabel = signup
		? ["Already have an account?", "Sign in"]
		: registrationOpen
			? ["New to Toolstile?", "Create an account"]
			: ["Have an invitation?", "Create an account"];
	if (!optionsSettled) return <AuthLoading label="Loading sign-in options…" />;
	return (
		<AuthFrame footer={signup && legal ? undefined : footer}>
			<form
				ref={formRef}
				onSubmit={submit}
				onFocus={keepInView}
				noValidate
				aria-labelledby={`${id}-title`}
				{...stylex.props(authFrame.card)}
			>
				<h1 id={`${id}-title`} {...stylex.props(authStyles.title)}>
					{signup ? "Create your account" : "Sign in"}
				</h1>
				{signup && !registrationOpen && (
					<p {...stylex.props(authStyles.description)}>
						Use an invitation from the person running this instance to create
						your account.
					</p>
				)}
				{optionsState !== "ready" && (
					<p
						role="status"
						{...stylex.props(authStyles.fieldHint, authStyles.notice)}
					>
						{optionsState === "loading" ? (
							"Checking sign-in options…"
						) : (
							<>
								Other sign-in options could not load.{" "}
								<button
									type="button"
									disabled={pending}
									onClick={() => setOptionsAttempt((attempt) => attempt + 1)}
									{...stylex.props(authStyles.inlineAction)}
								>
									Try again
								</button>
							</>
						)}
					</p>
				)}
				{(providers.length > 0 || alternativeMethods) && (
					<>
						<div inert={pending} {...stylex.props(authStyles.socialButtons)}>
							{providers.map((provider) => (
								<button
									key={provider}
									type="button"
									disabled={pending}
									aria-busy={
										pending &&
										pendingMethod ===
											(provider === "google" ? "Google" : "GitHub")
									}
									onClick={() => void signInWith(provider)}
									{...stylex.props(
										controls.button,
										authStyles.socialButton,
										pending &&
											pendingMethod ===
												(provider === "google" ? "Google" : "GitHub") &&
											authStyles.busy,
									)}
								>
									{pending &&
									pendingMethod ===
										(provider === "google" ? "Google" : "GitHub") ? (
										<CircleNotchIcon
											size={16}
											weight="bold"
											aria-hidden="true"
											{...stylex.props(authStyles.spinner)}
										/>
									) : provider === "github" ? (
										<GithubLogoIcon size={16} aria-hidden="true" />
									) : (
										<GoogleMark />
									)}
									{pending &&
									pendingMethod ===
										(provider === "google" ? "Google" : "GitHub")
										? `Connecting to ${pendingMethod}…`
										: `Continue with ${provider === "github" ? "GitHub" : "Google"}`}
								</button>
							))}
							{alternativeMethods}
						</div>
						<div {...stylex.props(authStyles.divider)}>
							<span {...stylex.props(authStyles.dividerLine)} />
							or
							<span {...stylex.props(authStyles.dividerLine)} />
						</div>
					</>
				)}
				{signup &&
					field("name", "Name", { autoComplete: "name", maxLength: 100 })}
				{field("email", "Email", {
					type: "email",
					autoComplete: "email",
					inputMode: "email",
					spellCheck: false,
					defaultValue:
						initialEmail ?? params.get("email") ?? invitationEmail ?? "",
				})}
				{field(
					"password",
					"Password",
					{
						type: passwordVisible ? "text" : "password",
						maxLength: 128,
						autoComplete: signup ? "new-password" : "current-password",
					},
					<button
						type="button"
						aria-label={passwordVisible ? "Hide password" : "Show password"}
						aria-pressed={passwordVisible}
						onClick={() => setPasswordVisible((visible) => !visible)}
						{...stylex.props(authStyles.toggle)}
					>
						{passwordVisible ? (
							<EyeSlashIcon size={18} aria-hidden="true" />
						) : (
							<EyeIcon size={18} aria-hidden="true" />
						)}
					</button>,
					signup
						? passwordLength > 0 && passwordLength < 12
							? `${12 - passwordLength} more to go`
							: "12 characters or more"
						: undefined,
					!signup && recoveryHref ? (
						<a href={recoveryHref} {...stylex.props(authStyles.recovery)}>
							Recover account
						</a>
					) : undefined,
				)}
				{signup &&
					!registrationOpen &&
					!acceptedInvitation &&
					!(providedInvitationToken ?? params.get("invite")) &&
					field("invitationToken", "Invitation token", {
						type: "password",
						autoComplete: "off",
					})}
				{error && (
					<div
						ref={errorRef}
						tabIndex={-1}
						{...stylex.props(authStyles.notice)}
					>
						<Notice error>{error}</Notice>
					</div>
				)}
				<button
					ref={submitRef}
					type="submit"
					disabled={pending}
					aria-busy={pending && pendingMethod === "email"}
					{...stylex.props(
						controls.button,
						controls.primary,
						authStyles.submit,
						pending && pendingMethod === "email" && authStyles.busy,
					)}
				>
					{pending && pendingMethod === "email" ? (
						<>
							<CircleNotchIcon
								size={16}
								weight="bold"
								aria-hidden="true"
								{...stylex.props(authStyles.spinner)}
							/>
							{signup ? "Creating account…" : "Signing in…"}
						</>
					) : signup ? (
						"Create account"
					) : (
						"Sign in"
					)}
				</button>
				{signup && legal && <p {...stylex.props(authStyles.legal)}>{legal}</p>}
				<p {...stylex.props(authStyles.switchLine)}>
					{switchLabel[0]}{" "}
					{modeHref ? (
						<a href={modeHref} {...stylex.props(authStyles.inlineAction)}>
							{switchLabel[1]}
						</a>
					) : (
						<button
							type="button"
							disabled={pending}
							{...stylex.props(authStyles.inlineAction)}
							onClick={() => {
								setError("");
								onModeChange(
									signup ? "signin" : "signup",
									String(
										formRef.current
											? (new FormData(formRef.current).get("email") ?? "")
											: "",
									).trim(),
								);
							}}
						>
							{switchLabel[1]}
						</button>
					)}
				</p>
			</form>
		</AuthFrame>
	);
}

/** Google's four-colour "G"; brand marks keep their own colours. */
function GoogleMark() {
	return (
		<svg viewBox="0 0 48 48" width={16} height={16} aria-hidden="true">
			<path
				fill="#EA4335"
				d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
			/>
			<path
				fill="#4285F4"
				d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
			/>
			<path
				fill="#FBBC05"
				d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
			/>
			<path
				fill="#34A853"
				d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
			/>
		</svg>
	);
}

const spin = stylex.keyframes({
	from: { transform: "rotate(0deg)" },
	to: { transform: "rotate(360deg)" },
});

const coarse = "@media (pointer: coarse)";
// Grows a text link's hit area without moving the line it sits in.
const hitArea = {
	content: '""',
	position: "absolute",
	insetBlock: { default: -6, [coarse]: -12 },
	insetInline: -4,
} as const;

const authStyles = stylex.create({
	title: {
		margin: "0 0 20px",
		textAlign: "center",
		fontSize: text.pageTitle,
		lineHeight: text.pageTitleLeading,
		letterSpacing: "-0.01em",
		fontWeight: 600,
	},
	description: {
		margin: "-12px 0 20px",
		textAlign: "center",
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
	},
	socialButtons: { display: "grid", gap: 8 },
	// 4px block padding lands buttons and inputs exactly on the 32px control height.
	socialButton: { width: "100%", paddingBlock: 4 },
	input: { paddingBlock: 4 },
	divider: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		margin: "16px 0 14px",
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	dividerLine: { flexGrow: 1, height: 1, backgroundColor: colors.line },
	// Label and aside share the first row; the input and any error span both columns.
	field: {
		display: "grid",
		gridTemplateColumns: "1fr auto",
		alignItems: "baseline",
		columnGap: 12,
		rowGap: 4,
		marginBottom: 12,
	},
	label: {
		gridColumn: 1,
		gridRow: 1,
		fontWeight: 500,
		fontSize: 13,
		lineHeight: "20px",
	},
	aside: {
		gridColumn: 2,
		gridRow: 1,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontVariantNumeric: "tabular-nums",
	},
	inputWrap: { gridColumn: "1 / -1", gridRow: 2, position: "relative" },
	inputWithToggle: { paddingRight: `calc(${size.control} + 4px)` },
	inputInvalid: {
		borderColor: { default: colors.bad, ":focus-visible": colors.bad },
		boxShadow: {
			default: "none",
			":focus-visible": `0 0 0 3px ${colors.badTint}`,
		},
	},
	// Fills the input's height; the content-box clip keeps the visible hover square inset.
	toggle: {
		position: "absolute",
		top: 0,
		right: 0,
		width: size.control,
		height: size.control,
		display: "grid",
		placeItems: "center",
		padding: 2,
		backgroundClip: "content-box",
		borderWidth: 0,
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hover,
			":focus-visible": colors.hover,
		},
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		cursor: "pointer",
		outlineWidth: 2,
		outlineStyle: { default: "none", ":focus-visible": "solid" },
		outlineColor: colors.action,
		outlineOffset: -2,
	},
	fieldHint: {
		margin: 0,
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
	},
	fieldError: {
		gridColumn: "1 / -1",
		gridRow: 3,
		display: "flex",
		alignItems: "flex-start",
		gap: 6,
		margin: 0,
		color: colors.bad,
		fontSize: 13,
		lineHeight: "20px",
	},
	fieldErrorIcon: { flexShrink: 0, marginTop: 2 },
	notice: { marginBottom: 12 },
	submit: { width: "100%", marginTop: 8, paddingBlock: 4, fontWeight: 600 },
	// Busy is not unavailable: keep the fill at full strength while the request runs.
	busy: { opacity: 1, cursor: "progress" },
	spinner: {
		animationName: {
			default: spin,
			"@media (prefers-reduced-motion: reduce)": "none",
		},
		animationDuration: "800ms",
		animationTimingFunction: "linear",
		animationIterationCount: "infinite",
	},
	legal: {
		margin: "12px 0 0",
		textAlign: "center",
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	switchLine: {
		margin: "20px 0 0",
		textAlign: "center",
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
	},
	inlineAction: {
		position: "relative",
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: colors.action,
		fontFamily: geometry.fontSans,
		fontSize: "inherit",
		lineHeight: "inherit",
		fontWeight: 500,
		textDecoration: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
		},
		textUnderlineOffset: 3,
		cursor: "pointer",
		borderRadius: geometry.corner,
		outlineWidth: 2,
		outlineStyle: { default: "none", ":focus-visible": "solid" },
		outlineColor: colors.action,
		outlineOffset: 2,
		transitionProperty: "color",
		transitionDuration: motion.fast,
		"::before": hitArea,
	},
	// Coarse pointers get a real 44px row, so the target never overlaps the input below it.
	recovery: {
		position: "relative",
		display: "inline-flex",
		alignItems: "center",
		minHeight: { default: 0, [coarse]: 44 },
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		textDecorationLine: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
		},
		textUnderlineOffset: 3,
		borderRadius: geometry.corner,
		outlineWidth: 2,
		outlineStyle: { default: "none", ":focus-visible": "solid" },
		outlineColor: colors.action,
		outlineOffset: 2,
		"::before": {
			content: '""',
			position: "absolute",
			top: { default: -8, [coarse]: 0 },
			bottom: { default: -4, [coarse]: 0 },
			insetInline: -4,
		},
	},
});
