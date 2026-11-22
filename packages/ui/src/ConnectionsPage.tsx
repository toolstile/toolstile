import type { Icon } from "@phosphor-icons/react";
import {
	ArrowsClockwiseIcon,
	CaretRightIcon,
	FlaskIcon,
	LinkBreakIcon,
	PlugsConnectedIcon,
	PlusIcon,
	SignInIcon,
	XIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect } from "react";
import type { CatalogState } from "./AccessManager";
import { AgentMark } from "./AgentMark";
import { ConnectionMark } from "./ConnectionMark";
import { controls } from "./Control.styles";
import { dashboardStyles as styles } from "./Dashboard.styles";
import { useDashboard } from "./DashboardContext";
import { layout } from "./Layout.styles";
import { EmptyState, Notice, RelativeTime } from "./Primitives";
import { StatusBadge } from "./StatusBadge";
import {
	connectionStatus,
	connectionStatusHint,
	connectionUnreachable,
	sameServerAddress,
	specificMessage,
} from "./status";
import { Tooltip } from "./Tooltip";
import { colors, text } from "./tokens.stylex";
import { UrlText } from "./UrlText";

/**
 * The connections page: the connection list with its added-connection notice. `navigation` is
 * the app's Connected / Browse catalog switch above it. The notice offers one next step: connect
 * an agent while there is none, otherwise choose which agents can use the new connection.
 */
export function ConnectionsPage({ navigation }: { navigation?: ReactNode }) {
	const {
		data,
		api,
		busy,
		catalogs,
		checks,
		loadCatalog,
		verify,
		added,
		addedAddress,
		addedSignedIn,
		setAdded,
		confirm,
		openConnectAgent,
		onDialogChange,
		onBrowseConnectors,
		renderAccessLink,
		connectionAccessSummary,
	} = useDashboard();
	const addedConnection = data.connections.find(({ id }) => id === added);
	const addedUnreachable =
		!!addedConnection && connectionUnreachable(addedConnection.status);
	const addedElsewhere =
		!!addedConnection &&
		!!addedAddress &&
		!sameServerAddress(addedConnection.url, addedAddress);
	const hasAgents = data.agents.some((agent) => !agent.revoked);
	const showAdded = Boolean(addedConnection);
	useEffect(() => {
		if (!added || !showAdded) return;
		document
			.querySelector(`[data-connection-row="${CSS.escape(added)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [added, showAdded]);
	return (
		<>
			{navigation}
			{showAdded && addedConnection && addedUnreachable ? (
				<div role="status" {...stylex.props(styles.pageNotice)}>
					<Notice tone="warning">
						<div {...stylex.props(styles.noticeRow)}>
							<span {...stylex.props(styles.noticeText)}>
								<strong>{addedConnection.label}</strong> was added, but
								Toolstile could not reach an MCP server at{" "}
								{/* A very long address is in the row below; repeating it would fill the page. */}
								{addedConnection.url.length > 120 ? (
									"its address"
								) : (
									<UrlText url={addedConnection.url} />
								)}
								. Check the address. Many MCP server addresses end in /mcp. To
								use a different address, disconnect this connection and add it
								again.
							</span>
							<button
								type="button"
								aria-label="Dismiss"
								{...stylex.props(
									controls.button,
									controls.quiet,
									controls.small,
									controls.iconOnly,
									styles.noticeDismiss,
								)}
								onClick={() => setAdded("")}
							>
								<XIcon size={16} />
							</button>
						</div>
					</Notice>
				</div>
			) : showAdded && addedConnection ? (
				<div role="status" {...stylex.props(styles.pageNotice)}>
					<Notice tone="success">
						<div {...stylex.props(styles.noticeRow, local.noticeWrap)}>
							<span {...stylex.props(styles.noticeText)}>
								<strong>{addedConnection.label}</strong>{" "}
								{addedSignedIn ? "is signed in." : "was added."}{" "}
								{addedElsewhere ? (
									<>
										Toolstile found its MCP server at{" "}
										<UrlText url={addedConnection.url} />.{" "}
									</>
								) : null}
								{hasAgents
									? "Next: choose which agents can use it."
									: "Next: connect an agent (an AI app or script that uses your connections)."}
							</span>
							{hasAgents ? (
								renderAccessLink({
									server: addedConnection.id,
									search: { server: addedConnection.id },
									className:
										stylex.props(controls.button, controls.small).className ??
										"",
									children: "Choose agent access",
								})
							) : (
								<button
									type="button"
									{...stylex.props(controls.button, controls.small)}
									onClick={() => openConnectAgent()}
								>
									Connect an agent
								</button>
							)}
							<button
								type="button"
								aria-label="Dismiss"
								{...stylex.props(
									controls.button,
									controls.quiet,
									controls.small,
									controls.iconOnly,
								)}
								onClick={() => setAdded("")}
							>
								<XIcon size={16} />
							</button>
						</div>
					</Notice>
				</div>
			) : null}
			{data.connections.length ? (
				<div {...stylex.props(styles.connectionList)}>
					<div {...stylex.props(styles.connectionGrid)}>
						{/* Labels the columns; stacked rows carry their own context. */}
						<div
							aria-hidden="true"
							{...stylex.props(
								styles.connectionGridRow,
								styles.connectionHeaderRow,
							)}
						>
							<span>MCP connection</span>
							<span>Status</span>
							<span>Capabilities</span>
							<span>Agent access</span>
							<span />
						</div>
						{data.connections.map((c) => {
							// A tool check made in this browser outranks the stored status.
							const shown = connectionStatus(c.status, checks[c.id]);
							const status = shown.trim().toLowerCase();
							const catalog = catalogs[c.id];
							const hint =
								catalog?.status === "error" && status === "needs attention"
									? (specificMessage(catalog.message) ??
										connectionStatusHint(status))
									: connectionStatusHint(status);
							const canSignIn =
								c.authentication === "oauth" && c.canManageAuthentication;
							// Recovery stays a visible button; routine refresh lives in the menu.
							const signInFirst =
								canSignIn &&
								(status === "authentication required" ||
									status === "needs reconnection" ||
									status === "needs attention");
							// Checking tools needs permission to manage the catalog where the host enforces it.
							const canCheck = c.canCheckTools !== false;
							// Unreachable or unchecked rows show a visible check, not only the menu item.
							const checkFirst =
								canCheck &&
								!signInFirst &&
								(status === "needs attention" || status === "configured");
							const accessSummary = connectionAccessSummary(c.id, true);
							const everyone = data.allAgentGrants.some(
								(grant) => grant.connectionId === c.id,
							);
							const granted = new Set(
								data.grants
									.filter((grant) => grant.connectionId === c.id)
									.map((grant) => grant.agentId),
							);
							const agentsWithAccess = data.agents.filter(
								(agent) =>
									!agent.revoked && (everyone || granted.has(agent.id)),
							);
							// The badge names the problem; the line under it says what to check, or when it was checked.
							const badgeLabel = signInFirst
								? "Needs sign-in"
								: status === "needs attention"
									? "Unreachable"
									: undefined;
							const note = signInFirst
								? connectionStatusHint("authentication required")
								: hint;
							const checkedAt =
								catalog?.status === "ready" ? catalog.checkedAt : undefined;
							const signIn = () =>
								onDialogChange("upstream-oauth", {
									connectionId: c.id,
								});
							return (
								<article
									{...stylex.props(
										stylex.defaultMarker(),
										styles.connectionRow,
										styles.connectionGridRow,
										(signInFirst || checkFirst) &&
											styles.connectionGridRowRecover,
										c.id === added && local.addedRow,
									)}
									key={c.id}
									data-connection-row={c.id}
								>
									<div {...stylex.props(styles.connectionMain)}>
										<ConnectionMark
											label={c.label}
											url={c.url}
											logoUrl={c.logoUrl}
										/>
										<div {...stylex.props(styles.connectionInfo)}>
											<div {...stylex.props(styles.connectionTitleLine)}>
												<h2
													title={c.label}
													{...stylex.props(styles.connectionTitle)}
												>
													{c.label}
												</h2>
											</div>
											<div {...stylex.props(styles.connectionUrl)}>
												{/* A local command shows its command line and only the names of its variables. */}
												<UrlText url={c.command ?? c.url} muted />
												{c.environment?.length ? (
													<span
														title={c.environment.join(", ")}
														{...stylex.props(local.connectionHint)}
													>
														{" "}
														with {c.environment.join(", ")}
													</span>
												) : null}
											</div>
										</div>
									</div>
									<div {...stylex.props(styles.connectionState)}>
										<StatusBadge
											status={shown}
											tone={badgeLabel === "Unreachable" ? "bad" : undefined}
										>
											{badgeLabel}
										</StatusBadge>
										{note ? (
											<span
												title={note}
												{...stylex.props(
													local.connectionHint,
													badgeLabel === "Unreachable" &&
														local.connectionHintBad,
												)}
											>
												{note}
											</span>
										) : checkedAt ? (
											<span {...stylex.props(local.connectionHint)}>
												Checked <RelativeTime value={checkedAt} compact />
											</span>
										) : null}
									</div>
									<ConnectionFacts
										catalog={catalog}
										unavailable={signInFirst || checkFirst || !canCheck}
										onLoad={() => loadCatalog(c.id, true)}
									/>
									<div {...stylex.props(styles.connectionAccess)}>
										{renderAccessLink({
											server: c.id,
											search: { server: c.id },
											className:
												stylex.props(
													stylex.defaultMarker(),
													styles.connectionFactLink,
													accessSummary.startsWith("No ") &&
														styles.connectionFactLinkNone,
												).className ?? "",
											children: (
												<>
													{agentsWithAccess.length &&
													!accessSummary.startsWith("No ") ? (
														<AgentStack agents={agentsWithAccess} />
													) : null}
													<span
														title={connectionAccessSummary(c.id)}
														{...stylex.props(styles.connectionFactLinkText)}
													>
														<span {...stylex.props(layout.visuallyHidden)}>
															{`Configure access for ${c.label}: `}
														</span>
														{accessSummary}
													</span>
													<CaretRightIcon
														size={12}
														aria-hidden="true"
														{...stylex.props(local.accessCaret)}
													/>
												</>
											),
										})}
									</div>
									<div {...stylex.props(styles.connectionActions)}>
										<div
											{...stylex.props(styles.connectionMenu, local.rowIcons)}
										>
											{canCheck && !signInFirst && !checkFirst ? (
												<RowIcon
													label={`Refresh tools for ${c.label}`}
													tip="Refresh tools"
													icon={ArrowsClockwiseIcon}
													disabled={busy}
													onClick={() => verify(c)}
												/>
											) : null}
											{canSignIn && !signInFirst ? (
												<RowIcon
													label={`Sign in again to ${c.label}`}
													tip="Sign in again"
													icon={SignInIcon}
													disabled={busy}
													onClick={signIn}
												/>
											) : null}
											<RowIcon
												label={`Test a tool on ${c.label}`}
												tip="Test tool"
												icon={FlaskIcon}
												disabled={busy}
												onClick={() =>
													onDialogChange("test-tool", { connectionId: c.id })
												}
											/>
											<RowIcon
												label={`Disconnect ${c.label}`}
												tip="Disconnect"
												icon={LinkBreakIcon}
												danger
												disabled={busy}
												onClick={() =>
													confirm({
														title: `Disconnect ${c.label}?`,
														body: "Agent access to this connection will be removed.",
														confirmLabel: "Disconnect",
														success: "Disconnected",
														work: () => api.removeConnection({ id: c.id }),
													})
												}
											/>
										</div>
										{signInFirst ? (
											<button
												type="button"
												{...stylex.props(
													controls.button,
													controls.small,
													styles.connectionRecover,
													local.recoverButton,
												)}
												disabled={busy}
												onClick={signIn}
											>
												Sign in
												<span {...stylex.props(layout.visuallyHidden)}>
													{` ${c.label}`}
												</span>
											</button>
										) : checkFirst ? (
											<button
												type="button"
												{...stylex.props(
													controls.button,
													controls.small,
													styles.connectionRecover,
													local.recoverButton,
												)}
												disabled={busy}
												onClick={() => verify(c)}
											>
												Retry
												<span {...stylex.props(layout.visuallyHidden)}>
													{` ${c.label}`}
												</span>
											</button>
										) : null}
									</div>
								</article>
							);
						})}
					</div>
				</div>
			) : (
				<EmptyState
					icon={PlugsConnectedIcon}
					action={
						<button
							type="button"
							{...stylex.props(controls.button)}
							onClick={
								onBrowseConnectors ?? (() => onDialogChange("connection"))
							}
						>
							<PlusIcon />
							Add an MCP connection
						</button>
					}
				>
					Add an MCP connection to make its tools available to your agents
				</EmptyState>
			)}
		</>
	);
}
/** A direct row action: a 28px ghost icon button named by its tooltip. */
function RowIcon({
	label,
	tip,
	icon: IconComponent,
	danger = false,
	disabled,
	onClick,
}: {
	label: string;
	tip: string;
	icon: Icon;
	danger?: boolean;
	disabled: boolean;
	onClick(): void;
}) {
	return (
		<Tooltip label={tip}>
			<button
				type="button"
				aria-label={label}
				disabled={disabled}
				onClick={onClick}
				{...stylex.props(
					controls.button,
					danger ? controls.quietDanger : controls.quiet,
					controls.small,
					controls.iconOnly,
					local.rowIcon,
				)}
			>
				<IconComponent size={16} aria-hidden="true" />
			</button>
		</Tooltip>
	);
}

/**
 * Discovered capability counts and when they were checked, as two grid cells; only checks
 * made during this session are known. Both cells always render so the columns stay put.
 */
function ConnectionFacts({
	catalog,
	unavailable,
	onLoad,
}: {
	catalog?: CatalogState;
	/** Failing rows recover through their own button, so they offer no tool load. */
	unavailable?: boolean;
	onLoad(): void;
}) {
	let summary: string;
	if (catalog?.status === "ready") {
		summary =
			(["tools", "resources", "prompts"] as const)
				.map((kind) => [kind, catalog.data[kind].length] as const)
				.filter(([, count]) => count)
				.map(
					([kind, count]) =>
						`${count} ${count === 1 ? kind.slice(0, -1) : kind}`,
				)
				.join(" · ") || "No tools";
	} else
		summary =
			catalog?.status === "loading"
				? "Loading tools…"
				: catalog?.status === "error"
					? "Tools could not load"
					: "";
	return (
		<div {...stylex.props(styles.connectionFacts)}>
			{unavailable && !summary ? (
				<span
					{...stylex.props(styles.connectionFact, styles.connectionFactEmpty)}
				>
					—
				</span>
			) : summary ? (
				<span
					title={catalog?.status === "error" ? catalog.message : summary}
					{...stylex.props(
						styles.connectionFact,
						catalog?.status === "error" && styles.connectionFactError,
					)}
				>
					{summary}
				</span>
			) : (
				// Nothing is stored in this browser yet; loading asks the server once.
				<span {...stylex.props(styles.connectionFact)}>
					<button
						type="button"
						onClick={onLoad}
						{...stylex.props(local.textButton, local.textButtonQuiet)}
					>
						Load tools
					</button>
				</span>
			)}
		</div>
	);
}

/**
 * Who can use a connection: up to three distinct agents (two Claude Codes share one mark) as
 * overlapping 20px circles, then "+N" for the rest. Decorative; the count beside it is the text.
 */
function AgentStack({ agents }: { agents: { id: string; label: string }[] }) {
	const seen = new Set<string>();
	const distinct = agents.filter((agent) => {
		const key = agent.label.trim().toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const shown = distinct.slice(0, 3);
	const more = distinct.length - shown.length;
	return (
		<span aria-hidden="true" {...stylex.props(local.agentStack)}>
			{shown.map((agent) => (
				<span key={agent.id} {...stylex.props(local.agentStackItem)}>
					<span {...stylex.props(local.agentStackMark)}>
						<AgentMark label={agent.label} size={22} />
					</span>
				</span>
			))}
			{more > 0 ? (
				<span {...stylex.props(local.agentStackItem, local.agentStackMore)}>
					+{more}
				</span>
			) : null}
		</span>
	);
}

const coarse = "@media (pointer: coarse)";

const addedArrive = stylex.keyframes({
	from: {
		backgroundColor: `color-mix(in srgb, ${colors.action} 22%, transparent)`,
	},
	to: { backgroundColor: colors.actionSoft },
});

const local = stylex.create({
	noticeWrap: { flexWrap: "wrap", alignItems: "center" },
	// The row just added or signed in keeps a soft tint until the notice is dismissed.
	// The new row lights up as it arrives, then rests on the soft tint.
	addedRow: {
		backgroundColor: colors.actionSoft,
		animationName: {
			default: addedArrive,
			"@media (prefers-reduced-motion: reduce)": "none",
		},
		animationDuration: "1400ms",
		animationTimingFunction: "ease-out",
	},
	// The line under the status badge; the full sentence stays in the title.
	connectionHint: {
		display: "block",
		minWidth: 0,
		marginTop: 2,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	connectionHintBad: { color: colors.bad },
	textButtonQuiet: { fontWeight: 400 },
	// The chevron appears with hover or keyboard focus on the access link.
	accessCaret: {
		flexShrink: 0,
		marginInlineStart: 4,
		color: "currentColor",
		opacity: {
			default: 0,
			[stylex.when.ancestor(":hover")]: 1,
			[stylex.when.ancestor(":focus-visible")]: 1,
		},
		transform: {
			default: "translateX(-2px)",
			[stylex.when.ancestor(":hover")]: "none",
			[stylex.when.ancestor(":focus-visible")]: "none",
		},
		transitionProperty: "opacity, transform",
		transitionDuration: "120ms",
	},
	rowIcon: {
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
	},
	recoverButton: { minWidth: 76, justifyContent: "center" },
	// Routine row actions stay out of sight until the row is hovered or holds focus, so a calm
	// list shows only the actions that need attention; touch screens always show them.
	rowIcons: {
		opacity: {
			default: 0,
			[stylex.when.ancestor(":hover")]: 1,
			[stylex.when.ancestor(":focus-within")]: 1,
			"@media (pointer: coarse)": 1,
		},
		transitionProperty: "opacity",
		transitionDuration: "120ms",
	},
	// Overlapping 20px circles before the count; each carries a 2px ring in the card colour so
	// the overlap stays crisp. The 22px square mark is centred and cropped by the circle.
	agentStack: {
		display: "inline-flex",
		alignItems: "center",
		marginInlineEnd: 8,
		paddingInlineStart: 4,
		flexShrink: 0,
	},
	agentStackItem: {
		position: "relative",
		display: "inline-grid",
		placeItems: "center",
		width: 20,
		height: 20,
		marginInlineStart: -4,
		borderRadius: "50%",
		overflow: "hidden",
		boxShadow: `0 0 0 2px ${colors.surface}`,
		backgroundColor:
			"color-mix(in srgb, #1c2029 calc(var(--theme-dark) * 100%), #fff)",
		flexShrink: 0,
		// A hairline edge drawn over the mark, so each circle reads on a white card.
		"::after": {
			content: '""',
			position: "absolute",
			inset: 0,
			borderRadius: "50%",
			boxShadow: `inset 0 0 0 1px ${colors.line}`,
			pointerEvents: "none",
		},
	},
	// Centres the 22px square mark in the 20px circle so its tile edge falls outside the crop.
	agentStackMark: {
		position: "absolute",
		top: -1,
		left: -1,
		display: "flex",
	},
	agentStackMore: {
		backgroundColor: colors.band,
		color: colors.muted,
		fontSize: 10,
		lineHeight: 1,
		fontWeight: 500,
		fontVariantNumeric: "tabular-nums",
	},
	// An inline action inside text; on touch screens a taller hit area reaches 44px.
	textButton: {
		position: "relative",
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: colors.action,
		fontFamily: "inherit",
		fontSize: "inherit",
		lineHeight: "inherit",
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "default" },
		opacity: { default: 1, ":disabled": 0.6 },
		textDecoration: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
		},
		textUnderlineOffset: 2,
		"::before": {
			content: '""',
			position: "absolute",
			insetInline: -4,
			top: { default: -4, [coarse]: -13 },
			bottom: { default: -4, [coarse]: -13 },
		},
	},
});
