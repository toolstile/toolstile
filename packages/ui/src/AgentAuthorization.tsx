import * as stylex from "@stylexjs/stylex";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	type AuthMode,
	oauthQueryWithoutPresentation,
	remoteCallback,
} from "./AuthNavigation";
import { AuthScreen } from "./AuthScreen";
import { Brand, standalone } from "./Brand";
import { controls } from "./Control.styles";
import { CopyValue } from "./CopyValue";
import { Disclosure } from "./Disclosure";
import { SelectField } from "./SelectField";
import { colors, geometry, typeScale } from "./tokens.stylex";

type Choices = {
	devices: { id: string; label: string; revoked?: boolean }[];
	agents: { id: string; label: string }[];
	account?: { name?: string; email?: string };
	selected?: { agentLabel: string; deviceLabel: string } | null;
	/** Detected names; `deviceId` is the device this browser approved from before. */
	suggested?: {
		agentLabel: string;
		deviceLabel: string;
		deviceId: string | null;
		clientName: string | null;
	};
};
const newDevice = "new";
/** A JSON body, or an empty one when a proxy or error page answered with something else. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
	try {
		const data: unknown = await response.json();
		return data && typeof data === "object"
			? (data as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
const nonEmpty = (value: unknown) =>
	typeof value === "string" && value ? value : undefined;
export function AgentAuthorization({
	consent = false,
	mode,
	onModeChange,
	headers = {},
	beforeFields,
	onAuthenticated,
	registrationOpen = false,
	ready = true,
	load = true,
	identityDetails = [],
}: {
	consent?: boolean;
	mode: AuthMode;
	onModeChange(mode: AuthMode): void;
	headers?: Record<string, string>;
	beforeFields?: ReactNode;
	onAuthenticated?(): void;
	registrationOpen?: boolean;
	/** The host must finish resolving its authorization context before approval. */
	ready?: boolean;
	/** Resolve host context before fetching the dependent connection. */
	load?: boolean;
	identityDetails?: { label: string; value: string }[];
}) {
	const fieldId = useId();
	const [loadedKey, setLoadedKey] = useState("");
	const actionLock = useRef(false);
	const [returning, setReturning] = useState<{
		url: string;
		declined: boolean;
	} | null>(null);
	const [choices, setChoices] = useState<Choices | null>(null);
	const [signedIn, setSignedIn] = useState(true);
	const [pendingAction, setPendingAction] = useState<
		"allow" | "decline" | null
	>(null);
	const pending = pendingAction !== null;
	const [error, setError] = useState("");
	const [requestEnded, setRequestEnded] = useState(false);
	const [reload, setReload] = useState(0);
	const [query, setQuery] = useState("");
	const [agentLabel, setAgentLabel] = useState("");
	const [deviceLabel, setDeviceLabel] = useState("");
	const [deviceChoice, setDeviceChoice] = useState(newDevice);
	const [remote, setRemote] = useState<
		| (NonNullable<ReturnType<typeof remoteCallback>> & { declined: boolean })
		| null
	>(null);
	const headerKey = JSON.stringify(headers);
	// The host may pass a new callback each render; loading choices must not restart for it.
	const authenticated = useRef(onAuthenticated);
	authenticated.current = onAuthenticated;
	// reload deliberately retries choice loading after sign-in even when the headers are unchanged.
	useEffect(() => {
		const oauthQuery = oauthQueryWithoutPresentation(window.location.search);
		setQuery(oauthQuery);
		const controller = new AbortController();
		setChoices(null);
		setError("");
		if (!new URLSearchParams(oauthQuery).get("sig")) {
			setError(
				"This connection request is missing or invalid. Start again from your agent app.",
			);
			return;
		}
		if (!load) return;
		fetch(
			`/api/agent-oauth${oauthQuery ? `?oauth_query=${encodeURIComponent(oauthQuery)}` : ""}`,
			{
				headers: JSON.parse(headerKey),
				signal: controller.signal,
			},
		)
			.then(async (response) => {
				if (controller.signal.aborted) return;
				if (response.status === 401) {
					setSignedIn(false);
					return;
				}
				if (!response.ok) {
					const data = await readJson(response);
					if (/expired/i.test(String(data.message ?? "")))
						setRequestEnded(true);
					throw new Error(
						nonEmpty(data.message) ??
							"Unable to load this connection request. Try again.",
					);
				}
				setSignedIn(true);
				const next = (await response
					.json()
					.catch(() => null)) as Choices | null;
				if (
					!next ||
					!Array.isArray(next.devices) ||
					!Array.isArray(next.agents)
				)
					throw new Error("Unable to load this connection request. Try again.");
				if (controller.signal.aborted) return;
				next.devices = next.devices.filter((device) => !device.revoked);
				const remembered = next.devices.find(
					(device) => device.id === next.suggested?.deviceId,
				);
				setAgentLabel(next.suggested?.agentLabel ?? "Agent connection");
				setDeviceLabel(next.suggested?.deviceLabel ?? "My device");
				setDeviceChoice(remembered?.id ?? newDevice);
				setChoices(next);
				setLoadedKey(headerKey);
			})
			.catch((e) => {
				if (!controller.signal.aborted)
					setError(
						e instanceof Error
							? e.message
							: "Unable to load this connection request. Try again.",
					);
			});
		return () => controller.abort();
	}, [headerKey, reload, load]);
	const reusedDevice =
		deviceChoice === newDevice
			? undefined
			: choices?.devices.find((device) => device.id === deviceChoice);
	const suggested = choices?.suggested;
	const clientName = suggested?.clientName;
	const params = new URLSearchParams(query);
	const clientId = params.get("client_id");
	const scopes = [
		...new Set((params.get("scope") ?? "").split(/\s+/).filter(Boolean)),
	];
	const unknownScopes = scopes.filter(
		(scope) =>
			!["openid", "profile", "offline_access", "mcp:access"].includes(scope),
	);
	const loaded = load && !!choices && loadedKey === headerKey;
	const canApprove =
		loaded &&
		ready &&
		!requestEnded &&
		(!consent || !!choices.selected) &&
		unknownScopes.length === 0;
	const bound = choices?.selected;
	const appName = clientName || "Unnamed app";
	const identity = loaded ? (
		<dl {...stylex.props(styles.identity)}>
			<div {...stylex.props(styles.identityRow)}>
				<dt {...stylex.props(styles.note)}>App</dt>
				<dd {...stylex.props(styles.value)}>{appName}</dd>
			</div>
			{choices.account?.email || choices.account?.name ? (
				<div {...stylex.props(styles.identityRow)}>
					<dt {...stylex.props(styles.note)}>Signed in as</dt>
					<dd {...stylex.props(styles.value)}>
						{choices.account.email || choices.account.name}
					</dd>
				</div>
			) : null}
			{!consent || bound ? (
				<>
					<div {...stylex.props(styles.identityRow)}>
						<dt {...stylex.props(styles.note)}>Agent</dt>
						<dd {...stylex.props(styles.value)}>
							{bound?.agentLabel || agentLabel.trim() || suggested?.agentLabel}
						</dd>
					</div>
					<div {...stylex.props(styles.identityRow)}>
						<dt {...stylex.props(styles.note)}>Device</dt>
						<dd {...stylex.props(styles.value)}>
							{bound?.deviceLabel ||
								reusedDevice?.label ||
								deviceLabel.trim() ||
								suggested?.deviceLabel}
						</dd>
					</div>
				</>
			) : null}
			{identityDetails.map((detail) => (
				<div key={detail.label} {...stylex.props(styles.identityRow)}>
					<dt {...stylex.props(styles.note)}>{detail.label}</dt>
					<dd {...stylex.props(styles.value)}>{detail.value}</dd>
				</div>
			))}
		</dl>
	) : null;
	async function authorize(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (actionLock.current || !canApprove) return;
		actionLock.current = true;
		setPendingAction("allow");
		setError("");
		try {
			if (!new URLSearchParams(query).has("sig"))
				throw new Error(
					"Start authorization from your agent app to receive a valid request.",
				);
			if (!consent && !bound) {
				// No agentId: the server creates the agent, and the device unless one is reused.
				const response = await fetch("/api/agent-oauth", {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({
						oauth_query: query,
						agentLabel: agentLabel.trim() || undefined,
						...(reusedDevice
							? { deviceId: reusedDevice.id }
							: {
									newDevice: true,
									deviceLabel: deviceLabel.trim() || undefined,
								}),
					}),
				});
				if (!response.ok) {
					const data = await readJson(response);
					throw new Error(
						nonEmpty(data.message) ?? "Unable to select this agent",
					);
				}
			}
			const response = await fetch(
				`/api/auth/oauth2/${consent ? "consent" : "continue"}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						oauth_query: query,
						...(consent ? { accept: true } : { postLogin: true }),
					}),
				},
			);
			const data = await readJson(response);
			if (!response.ok || typeof data.url !== "string") {
				if (
					/expired/i.test(
						String(data.error_description ?? data.message ?? ""),
					) ||
					data.error === "invalid_grant"
				)
					setRequestEnded(true);
				throw new Error(
					nonEmpty(data.error_description) ??
						nonEmpty(data.message) ??
						"Authorization failed. Start again from your agent app.",
				);
			}
			finish(data.url, false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Authorization failed");
		} finally {
			actionLock.current = false;
			setPendingAction(null);
		}
	}
	function finish(url: string, declined: boolean) {
		const callback = remoteCallback(query, url);
		if (callback) setRemote({ ...callback, declined });
		else {
			setReturning({ url, declined });
			window.location.assign(url);
		}
	}
	async function decline() {
		if (actionLock.current) return;
		actionLock.current = true;
		setPendingAction("decline");
		setError("");
		try {
			const response = await fetch("/api/auth/oauth2/consent", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ oauth_query: query, accept: false }),
			});
			const data = await readJson(response);
			if (!response.ok || typeof data.url !== "string")
				throw new Error(
					"Unable to decline this request. Close this page to cancel.",
				);
			finish(data.url, true);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Unable to cancel");
			setPendingAction(null);
		} finally {
			actionLock.current = false;
			setPendingAction(null);
		}
	}
	if (!signedIn)
		return (
			<AuthScreen
				mode={mode}
				onModeChange={onModeChange}
				registrationOpen={registrationOpen}
				onReady={() => {
					setSignedIn(true);
					authenticated.current?.();
					setReload((v) => v + 1);
				}}
			/>
		);
	if (remote)
		return (
			<main {...stylex.props(standalone.backdrop, styles.page)}>
				<div {...stylex.props(styles.column)}>
					<Brand />
					<section {...stylex.props(standalone.card, styles.form)}>
						<h1 {...stylex.props(styles.heading)}>
							{remote.declined
								? "Request declined"
								: `Finish on ${remote.device}`}
						</h1>
						<p {...stylex.props(styles.paragraph)}>
							{remote.declined
								? `Run this on ${remote.device} so the agent stops waiting:`
								: `The agent on ${remote.device} is waiting for this approval. Run this there within 10 minutes:`}
						</p>
						<CopyValue value={remote.command} />
						<p {...stylex.props(styles.note)}>
							The command works once and only for the agent that started this
							sign-in. You can close this page afterwards.
						</p>
					</section>
				</div>
			</main>
		);
	if (returning)
		return (
			<main {...stylex.props(standalone.backdrop, styles.page)}>
				<div {...stylex.props(styles.column)}>
					<Brand />
					<section
						aria-labelledby={`${fieldId}-result`}
						{...stylex.props(standalone.card, styles.form)}
					>
						<h1 id={`${fieldId}-result`} {...stylex.props(styles.heading)}>
							{returning.declined
								? "Request declined"
								: consent
									? "Connection allowed"
									: "Connection saved"}
						</h1>
						<p role="status" {...stylex.props(styles.paragraph)}>
							{returning.declined
								? "This request was refused. Returning the refusal to your app…"
								: consent
									? "Your permission was saved. Returning to your app…"
									: "Your named connection was saved. Opening permissions…"}
						</p>
						{identity}
						<p {...stylex.props(styles.note)}>
							{consent
								? "If the app did not open, use the button below. If it reports an expired request, start a new connection from the app."
								: "If the permission page did not open, use the button below to continue."}
						</p>
						<button
							type="button"
							{...stylex.props(
								controls.button,
								controls.primary,
								controls.large,
							)}
							onClick={() => window.location.assign(returning.url)}
						>
							{consent ? "Open app again" : "Open permissions again"}
						</button>
						<p {...stylex.props(styles.note)}>
							{returning.declined
								? "The saved entry remains in Devices & agents. Remove it there if you no longer need it."
								: "You can close this page once the app confirms the connection."}
						</p>
					</section>
				</div>
			</main>
		);
	return (
		<main {...stylex.props(standalone.backdrop, styles.page)}>
			<div {...stylex.props(styles.column)}>
				<Brand />
				<form
					onSubmit={authorize}
					aria-labelledby={`${fieldId}-title`}
					{...stylex.props(standalone.card, styles.form)}
				>
					<header {...stylex.props(styles.header)}>
						<p {...stylex.props(styles.note)}>
							{consent
								? "Step 2 of 2 · Allow connection"
								: "Step 1 of 2 · Name connection"}
						</p>
						<h1 id={`${fieldId}-title`} {...stylex.props(styles.heading)}>
							{consent ? "Allow this app to connect?" : "Connect an agent"}
						</h1>
						<p {...stylex.props(styles.paragraph)}>
							{consent
								? "Review what this app is asking to use."
								: "Choose where this agent connection belongs. You’ll review the app’s permissions next."}
						</p>
					</header>
					<fieldset
						disabled={pending || !!returning}
						{...stylex.props(styles.context)}
					>
						{beforeFields}
					</fieldset>
					{loaded ? (
						<>
							{identity}
							<p {...stylex.props(styles.note)}>
								The app is requesting access. Agent and device are the labels
								used to identify this connection in Toolstile.
							</p>
							<p {...stylex.props(styles.note)}>
								{clientName
									? "The app supplies its name. Continue only if you started this request in that app."
									: "This app did not provide a name. Check the request details and continue only if you recognize the app you started from."}
							</p>

							{!consent && unknownScopes.length ? (
								<p role="alert" {...stylex.props(styles.error)}>
									This request includes unsupported permissions. Cancel and
									start again from your agent app.
								</p>
							) : null}
							{consent ? (
								<section
									aria-labelledby={`${fieldId}-permissions`}
									{...stylex.props(styles.header)}
								>
									<h2
										id={`${fieldId}-permissions`}
										{...stylex.props(styles.subheading)}
									>
										This app is requesting permission to
									</h2>
									<ul {...stylex.props(styles.permissions)}>
										{scopes.includes("mcp:access") ? (
											<li>
												Discover and use MCP tools allowed for this agent. Each
												tool call still follows its access rules and any
												required approval.
											</li>
										) : null}
										{scopes.includes("openid") ? (
											<li>
												Identify your Toolstile account when signing in to the
												app.
											</li>
										) : null}
										{scopes.includes("profile") ? (
											<li>Read your profile name and picture, if available.</li>
										) : null}
										{scopes.includes("offline_access") ? (
											<li>
												Keep the connection active using renewable credentials,
												including when you close this page.
											</li>
										) : null}
										{!scopes.length ? (
											<li>
												No additional permissions were specified in this
												request.
											</li>
										) : null}
									</ul>
									{unknownScopes.length ? (
										<p role="alert" {...stylex.props(styles.error)}>
											This request includes permissions Toolstile cannot
											explain. Decline it and start again from the app.
										</p>
									) : null}
									{!bound ? (
										<p role="alert" {...stylex.props(styles.error)}>
											The agent connection could not be found. Start again from
											your agent app.
										</p>
									) : null}
									<p {...stylex.props(styles.note)}>
										Connecting does not add tool permissions. Manage access in
										Access; remove the connection in Devices &amp; agents to
										stop its access.
									</p>
								</section>
							) : (
								<>
									{!bound ? (
										<Disclosure compact summary="Edit agent and device names">
											<fieldset
												disabled={pending || !!returning}
												{...stylex.props(styles.names)}
											>
												<label {...stylex.props(controls.label, styles.field)}>
													Agent name
													<input
														{...stylex.props(controls.input, controls.large)}
														value={agentLabel}
														onChange={(event) =>
															setAgentLabel(event.target.value)
														}
														required
														maxLength={100}
													/>
												</label>
												{choices.devices.length ? (
													<label
														htmlFor={`${fieldId}-device`}
														{...stylex.props(controls.label, styles.field)}
													>
														Device
														<SelectField
															id={`${fieldId}-device`}
															aria-label="Device"
															size="large"
															value={deviceChoice}
															onValueChange={setDeviceChoice}
															items={[
																...choices.devices.map((device) => ({
																	value: device.id,
																	label: device.label,
																})),
																{ value: newDevice, label: "New device" },
															]}
														/>
													</label>
												) : null}
												{reusedDevice ? null : (
													<label
														{...stylex.props(controls.label, styles.field)}
													>
														Device name
														<input
															{...stylex.props(controls.input, controls.large)}
															value={deviceLabel}
															onChange={(event) =>
																setDeviceLabel(event.target.value)
															}
															required
															maxLength={100}
														/>
													</label>
												)}
											</fieldset>
										</Disclosure>
									) : null}
									<p {...stylex.props(styles.note)}>
										{bound
											? "This connection is already saved. Continue to review its permissions."
											: "Continuing saves this named connection in Devices & agents."}{" "}
										Tool permissions remain controlled in Access.
									</p>
								</>
							)}
							<Disclosure compact summary="Request details">
								<dl {...stylex.props(styles.details)}>
									<dt>App identifier</dt>
									<dd {...stylex.props(styles.code)}>
										{clientId || "Not provided"}
									</dd>
									<dt>Requested permissions (OAuth scopes)</dt>
									<dd {...stylex.props(styles.code)}>
										{scopes.join(", ") || "None specified"}
									</dd>
								</dl>
							</Disclosure>
						</>
					) : load && !error ? (
						<p role="status" {...stylex.props(styles.paragraph)}>
							Loading connection request…
						</p>
					) : null}
					{error ? (
						<div {...stylex.props(styles.header)}>
							<p role="alert" {...stylex.props(styles.error)}>
								{error}
							</p>
							{!loaded && params.get("sig") ? (
								<button
									type="button"
									{...stylex.props(controls.button, controls.large)}
									onClick={() => setReload((value) => value + 1)}
								>
									Try again
								</button>
							) : null}
							<p {...stylex.props(styles.note)}>
								If the request has expired or the connection was removed, close
								this page and start a new connection from your agent app.
							</p>
						</div>
					) : null}
					<div {...stylex.props(styles.actions)}>
						<button
							type="submit"
							{...stylex.props(
								controls.button,
								controls.primary,
								controls.large,
							)}
							disabled={pending || !!returning || !canApprove}
						>
							{pendingAction === "allow"
								? consent
									? "Allowing connection…"
									: "Preparing connection…"
								: consent
									? "Allow connection"
									: "Continue to permissions"}
						</button>
						{consent ? (
							<button
								{...stylex.props(controls.button, controls.large)}
								type="button"
								disabled={pending || !!returning || !params.get("sig")}
								onClick={decline}
							>
								{pendingAction === "decline"
									? "Declining connection…"
									: "Decline connection"}
							</button>
						) : (
							<a
								{...stylex.props(
									controls.button,
									controls.quiet,
									controls.large,
								)}
								href="/"
								aria-disabled={pending || !!returning}
								onClick={(event) => {
									if (pending || returning) event.preventDefault();
								}}
							>
								Cancel setup
							</a>
						)}
					</div>
					<p {...stylex.props(styles.note)}>
						{consent
							? "Allow returns you to the app. Decline refuses this request and keeps the saved entry; remove it in Devices & agents if you no longer need it."
							: "Cancel leaves this request unfinished. No connection credentials are sent to the app."}
					</p>
				</form>
			</div>
		</main>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "100dvh",
		paddingTop: { default: 48, "@media (max-width: 760px)": 24 },
		paddingInline: { default: 24, "@media (max-width: 760px)": 16 },
		paddingBottom: 64,
		color: colors.text,
		fontFamily: geometry.fontSans,
		// Account screens keep their 14px reading size under the 13px dashboard root.
		fontSize: typeScale.size14,
		lineHeight: 1.5,
	},
	column: {
		maxWidth: 560,
		marginInline: "auto",
		display: "grid",
		gap: { default: 32, "@media (max-width: 760px)": 24 },
	},
	form: { display: "grid", gap: 16 },
	names: {
		display: "grid",
		gap: 14,
		paddingBlock: 14,
		paddingInline: 0,
		borderWidth: 0,
		margin: 0,
		minWidth: 0,
	},
	heading: { margin: 0, fontSize: 22, lineHeight: "30px", fontWeight: 600 },
	header: { display: "grid", gap: 8 },
	subheading: { margin: 0, fontSize: 14, fontWeight: 500 },
	identity: {
		margin: 0,
		display: "grid",
		gap: 8,
		paddingBlock: 12,
		borderBlockWidth: 1,
		borderBlockStyle: "solid",
		borderBlockColor: colors.line,
	},
	identityRow: {
		display: "grid",
		gridTemplateColumns: "92px minmax(0, 1fr)",
		gap: 12,
		alignItems: "baseline",
	},
	value: { margin: 0, overflowWrap: "anywhere" },
	context: {
		borderWidth: 0,
		padding: 0,
		margin: 0,
		minWidth: 0,
		display: "grid",
		gap: 8,
	},
	permissions: {
		margin: 0,
		paddingLeft: 20,
		display: "grid",
		gap: 8,
		lineHeight: 1.6,
	},
	details: {
		margin: 0,
		paddingBlock: 12,
		display: "grid",
		gap: 8,
		fontSize: 13,
	},
	code: { margin: 0, fontFamily: geometry.fontMono, overflowWrap: "anywhere" },
	actions: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) auto",
			"@media (max-width: 480px)": "1fr",
		},
		gap: 8,
		marginTop: 4,
	},
	paragraph: { margin: 0, lineHeight: 1.6 },
	field: { display: "grid", gap: 8, margin: 0 },
	client: {
		margin: 0,
		lineHeight: 1.6,
		overflowWrap: "anywhere",
		color: colors.muted,
	},
	note: {
		margin: 0,
		fontSize: 13,
		lineHeight: 1.5,
		color: colors.muted,
	},
	error: { margin: 0, color: colors.bad },
});
