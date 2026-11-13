import {
	DesktopTowerIcon,
	HardDrivesIcon,
	type Icon,
	LaptopIcon,
	PencilSimpleIcon,
	PlusIcon,
	TerminalWindowIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { Rules, Snapshot } from "@toolstile/api/contract";
import { Fragment, type ReactNode, type SyntheticEvent, useState } from "react";
import { AgentMark } from "./AgentMark";
import { agentAccessSummaries } from "./access-rules";
import { ConnectionMark } from "./ConnectionMark";
import { darkMonochrome } from "./ConnectorLogo";
import { controls } from "./Control.styles";
import { dashboardStyles as styles } from "./Dashboard.styles";
import { type AccessLinkRenderer, useDashboard } from "./DashboardContext";
import { formatExpiry, formatFullDate } from "./format";
import { InlineRename } from "./InlineRename";
import { layout } from "./Layout.styles";
import { EmptyState } from "./Primitives";
import { StatusBadge } from "./StatusBadge";
import { Tooltip } from "./Tooltip";
import { colors, geometry, space, text } from "./tokens.stylex";

/** A laptop, server or desktop glyph guessed from the device name; only decoration. */
function deviceIcon(label: string): Icon {
	if (/mac\s?book|laptop|notebook|thinkpad|xps/i.test(label)) return LaptopIcon;
	if (/runner|server|\bci\b|build|node|vm|host|prod|staging/i.test(label))
		return HardDrivesIcon;
	return DesktopTowerIcon;
}

const week = 7 * 24 * 60 * 60 * 1000;

/** The devices page: agents grouped by the device they run on. Every action is one click. */
export function DevicesPage() {
	const {
		data,
		api,
		busy,
		renaming,
		setRenaming,
		rename,
		finishRename,
		createToken,
		confirm,
		openConnectAgent,
		onAccessViewChange,
		renderAccessLink,
		catalogs,
	} = useDashboard();
	return (
		<>
			{data.devices.length ? (
				<div {...stylex.props(layout.list)}>
					{data.devices.map((d) => {
						const agents = data.agents.filter((a) => a.deviceId === d.id);
						return (
							<Fragment key={d.id}>
								<div
									data-rename-anchor={d.id}
									{...stylex.props(
										stylex.defaultMarker(),
										layout.listGroupHeader,
										local.deviceHeader,
									)}
								>
									{(() => {
										const DeviceIcon = deviceIcon(d.label);
										return (
											<DeviceIcon
												size={16}
												aria-hidden="true"
												{...stylex.props(local.deviceIcon)}
											/>
										);
									})()}
									<h2 {...stylex.props(local.deviceTitle)}>
										{renaming?.kind === "device" && renaming.id === d.id ? (
											<InlineRename
												label={d.label}
												fieldLabel="Device name"
												busy={busy}
												onSave={(label) => rename("device", d.id, label)}
												onCancel={() => finishRename(d.id)}
											/>
										) : (
											<RenameTrigger
												overlay
												label={d.label}
												disabled={busy}
												onClick={() =>
													setRenaming({ kind: "device", id: d.id })
												}
											/>
										)}
									</h2>
									<span {...stylex.props(local.deviceCount)}>
										<span aria-hidden="true">· </span>
										{agents.length === 1
											? "1 agent"
											: `${agents.length} agents`}
									</span>
									<IconAction
										label="Create an agent token"
										icon={TerminalWindowIcon}
										disabled={busy}
										onClick={() => createToken(d.id)}
									/>
									<IconAction
										label="Remove device"
										icon={TrashIcon}
										danger
										disabled={busy}
										onClick={() => {
											const count = agents.length;
											confirm({
												title: `Remove ${d.label}?`,
												body: count
													? `Removes this device and its ${count} ${count === 1 ? "agent" : "agents"}. Their access stops immediately.`
													: "Removes this device.",
												confirmLabel: "Remove device",
												success: "Device removed",
												work: () => api.revokeDevice({ id: d.id }),
											});
										}}
									/>
								</div>
								{agents.map((a) => (
									<div
										data-rename-anchor={a.id}
										{...stylex.props(
											stylex.defaultMarker(),
											layout.listRow,
											local.agentRow,
										)}
										key={a.id}
									>
										<AgentMark label={a.label} />
										<div {...stylex.props(local.agentText)}>
											<span {...stylex.props(local.agentTitle)}>
												{renaming?.kind === "agent" && renaming.id === a.id ? (
													<InlineRename
														label={a.label}
														fieldLabel="Agent name"
														busy={busy}
														onSave={(label) => rename("agent", a.id, label)}
														onCancel={() => finishRename(a.id)}
													/>
												) : (
													<RenameTrigger
														label={a.label}
														disabled={busy}
														onClick={() =>
															setRenaming({ kind: "agent", id: a.id })
														}
													/>
												)}
											</span>
											<div {...stylex.props(local.meta)}>
												<AgentAccess
													data={data}
													catalogs={catalogs}
													agentId={a.id}
													renderLink={renderAccessLink}
													onGrant={() =>
														onAccessViewChange(
															{ server: undefined },
															false,
															a.id,
														)
													}
												/>
											</div>
										</div>
										<AgentState revoked={a.revoked} expiresAt={a.expiresAt} />
										<IconAction
											label="Remove agent"
											icon={TrashIcon}
											danger
											disabled={busy}
											onClick={() =>
												confirm({
													title: `Remove ${a.label}?`,
													body: "Stops this agent's access immediately.",
													confirmLabel: "Remove agent",
													success: "Agent removed",
													work: () => api.revokeAgent({ id: a.id }),
												})
											}
										/>
									</div>
								))}
								{!agents.length && (
									<p
										{...stylex.props(
											layout.listRow,
											local.agentRow,
											local.empty,
										)}
									>
										No agents connected yet
									</p>
								)}
							</Fragment>
						);
					})}
				</div>
			) : (
				<EmptyState
					icon={DesktopTowerIcon}
					action={
						<button
							type="button"
							{...stylex.props(controls.button)}
							onClick={() => openConnectAgent()}
						>
							<PlusIcon />
							Connect an agent
						</button>
					}
				>
					Connect an agent and its device appears here
				</EmptyState>
			)}
		</>
	);
}

/** A device or agent name that starts renaming in place when clicked. */
function RenameTrigger({
	label,
	disabled,
	onClick,
	overlay = false,
}: {
	label: string;
	disabled: boolean;
	onClick(): void;
	/** The pencil takes no room at rest, so text that follows the name sits close to it. */
	overlay?: boolean;
}) {
	return (
		<button
			type="button"
			title="Rename"
			disabled={disabled}
			onClick={onClick}
			data-rename-trigger=""
			{...stylex.props(
				local.renameTrigger,
				overlay && local.renameTriggerOverlay,
			)}
		>
			{label}
			<PencilSimpleIcon
				size={12}
				aria-hidden="true"
				{...stylex.props(local.renameIcon, overlay && local.renameIconOverlay)}
			/>
		</button>
	);
}

/** A small icon-only row action labelled by a tooltip. */
function IconAction({
	label,
	icon: IconComponent,
	danger = false,
	disabled,
	onClick,
}: {
	label: string;
	icon: Icon;
	danger?: boolean;
	disabled: boolean;
	onClick(): void;
}) {
	return (
		<Tooltip label={label}>
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
					danger ? local.dangerOnHover : local.mutedIcon,
					local.revealed,
				)}
			>
				<IconComponent size={16} aria-hidden="true" />
			</button>
		</Tooltip>
	);
}

/**
 * The agent's authorization state, once, on the right: revoked, expired or expiring as a status,
 * with the full date in the title. Agents without an expiry show nothing.
 */
function AgentState({
	revoked,
	expiresAt,
}: {
	revoked: boolean;
	expiresAt: string | null;
}) {
	let badge: ReactNode = null;
	if (revoked) badge = <StatusBadge status="Revoked" tone="bad" />;
	else if (expiresAt) {
		const left = new Date(expiresAt).getTime() - Date.now();
		badge = (
			<StatusBadge
				status={formatExpiry(expiresAt)}
				tone={left <= 0 ? "bad" : left <= week ? "warning" : "neutral"}
			/>
		);
	}
	return (
		<span
			title={expiresAt && !revoked ? formatFullDate(expiresAt) : undefined}
			{...stylex.props(local.term)}
		>
			{badge}
		</span>
	);
}

/** A chip's 14px logo drawn straight on the chip, or the letter mark when there is none. */
function ChipLogo({
	label,
	url,
	logoUrl,
}: {
	label: string;
	url: string;
	logoUrl?: string | null;
}) {
	const [mono, setMono] = useState(false);
	if (!logoUrl?.startsWith("/connector-logos/"))
		return <ConnectionMark label={label} url={url} size={14} />;
	return (
		<img
			src={logoUrl}
			alt=""
			width={14}
			height={14}
			decoding="async"
			onLoad={(event: SyntheticEvent<HTMLImageElement>) =>
				setMono(darkMonochrome(event.currentTarget))
			}
			{...stylex.props(local.chipLogo, mono && local.chipLogoMono)}
		/>
	);
}

/**
 * An agent's access as one scannable line: a logo per MCP connection, each linking to that
 * connection's access page with its exact summary as the label, then a short count.
 */
/**
 * How many of a connection's tools a limited grant allows, as "13/31" when the catalog is
 * known in this browser, else "13". Undefined when the grant names no tools.
 */
function allowedFraction(
	data: Snapshot,
	agentId: string,
	connectionId: string,
	total: number | undefined,
) {
	const sets = [
		data.grants.find(
			(g) => g.agentId === agentId && g.connectionId === connectionId,
		)?.rules,
		data.allAgentGrants.find((g) => g.connectionId === connectionId)?.rules,
	].filter((rules): rules is Rules => !!rules);
	const blocked = new Set(sets.flatMap((r) => r.block.tools));
	const allowed = new Set(
		sets
			.flatMap((r) => [...r.allow.tools, ...(r.requireApproval ?? [])])
			.filter((tool) => !blocked.has(tool)),
	);
	if (!allowed.size) return undefined;
	return total ? `${allowed.size}/${total}` : String(allowed.size);
}

function AgentAccess({
	data,
	catalogs,
	agentId,
	renderLink,
	onGrant,
}: {
	data: Snapshot;
	catalogs: ReturnType<typeof useDashboard>["catalogs"];
	agentId: string;
	renderLink: AccessLinkRenderer;
	onGrant(): void;
}) {
	const summaries = agentAccessSummaries(data, agentId);
	if (!summaries.length) {
		return (
			<span {...stylex.props(local.accessLine)}>
				No access yet<span aria-hidden="true"> · </span>
				<button
					type="button"
					onClick={onGrant}
					{...stylex.props(styles.agentAccessLink, local.grantAccess)}
				>
					Grant access
				</button>
			</span>
		);
	}
	const className =
		stylex.props(styles.agentAccessLink, local.logoLink).className ?? "";
	return (
		<span {...stylex.props(local.accessLine)}>
			<span {...stylex.props(local.logos)}>
				{summaries.map(({ connection, summary }) => (
					<Fragment key={connection.id}>
						{renderLink({
							server: connection.id,
							agentId,
							className,
							children: (
								<span
									title={`${connection.label}: ${summary}`}
									{...stylex.props(local.logo)}
								>
									<ChipLogo
										label={connection.label}
										url={connection.url}
										logoUrl={connection.logoUrl}
									/>
									{connection.label}
									<span {...stylex.props(layout.visuallyHidden)}>
										{`: ${summary}`}
									</span>
									{summary === "full access"
										? null
										: (() => {
												// Limited access: allowed of total tools; the exact limit is in the title.
												const catalog = catalogs[connection.id];
												const fraction = allowedFraction(
													data,
													agentId,
													connection.id,
													catalog?.status === "ready"
														? catalog.data.tools.length
														: undefined,
												);
												return fraction ? (
													<span
														aria-hidden="true"
														{...stylex.props(local.limited)}
													>
														{fraction}
													</span>
												) : null;
											})()}
								</span>
							),
						})}
					</Fragment>
				))}
			</span>
		</span>
	);
}

const mobile = "@media (max-width: 760px)";

const local = stylex.create({
	// The shared group band (colors.band), so each device reads as a label over its agents.
	deviceHeader: {
		minHeight: 32,
		paddingBlock: 0,
		backgroundColor: colors.band,
		borderTopLeftRadius: { default: 0, ":first-child": geometry.corner },
		borderTopRightRadius: { default: 0, ":first-child": geometry.corner },
	},
	deviceIcon: { flexShrink: 0, color: colors.muted },
	deviceTitle: {
		minWidth: 0,
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		overflowWrap: "anywhere",
	},
	// Follows the name; slides aside while the overlaid rename pencil shows.
	deviceCount: {
		flex: "1 1 auto",
		transform: {
			default: "none",
			[stylex.when.ancestor(":hover")]: "translateX(20px)",
			[stylex.when.ancestor(":focus-within")]: "translateX(20px)",
		},
		transitionProperty: {
			default: "transform",
			"@media (prefers-reduced-motion: reduce)": "none",
		},
		transitionDuration: "120ms",
		minWidth: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 400,
		fontVariantNumeric: "tabular-nums",
	},
	// Agent icons share the device icon's 16px edge; the band above already groups them.
	agentRow: {
		minHeight: 56,
		paddingBlock: 6,
		paddingInlineStart: { default: space.s4, [mobile]: space.s3 },
	},
	agentText: { flex: "1 1 auto", minWidth: 0 },
	// The name, then any expiry or revocation right after the rename pencil's slot.
	agentTitle: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		columnGap: space.s1,
		fontWeight: 500,
		overflowWrap: "anywhere",
	},
	// Looks like the plain name; the pencil and a faint wash show it can be edited.
	renameTrigger: {
		display: "inline-flex",
		alignItems: "center",
		// 12px, so the save button that replaces the pencil sits clear of the edit field.
		gap: space.s3,
		maxWidth: "100%",
		padding: 0,
		borderStyle: "none",
		borderRadius: geometry.cornerSmall,
		backgroundColor: "transparent",
		color: "inherit",
		fontFamily: "inherit",
		fontSize: "inherit",
		fontWeight: "inherit",
		lineHeight: "inherit",
		textAlign: "start",
		overflowWrap: "anywhere",
		cursor: { default: "pointer", ":disabled": "not-allowed" },
	},
	renameTriggerOverlay: { position: "relative" },
	renameIconOverlay: {
		position: "absolute",
		insetInlineStart: "calc(100% + 8px)",
		top: "50%",
		marginTop: -6,
	},
	renameIcon: {
		flexShrink: 0,
		color: colors.muted,
		// Shown while the row is hovered or focused; always faintly visible without hover.
		opacity: {
			default: 0,
			"@media (hover: none)": 0.6,
			[stylex.when.ancestor(":hover")]: 1,
			[stylex.when.ancestor(":focus-within")]: 1,
		},
	},
	// Row action colours; `revealed` hides them until the row is pointed at or focused.
	mutedIcon: {
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
	},
	dangerOnHover: {
		color: {
			default: colors.muted,
			":hover": colors.bad,
			":focus-visible": colors.bad,
		},
	},
	accessLine: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minWidth: 0,
	},
	logos: {
		display: "inline-flex",
		alignItems: "center",
		flexWrap: "wrap",
		columnGap: space.s2,
		rowGap: space.s1,
		minWidth: 0,
	},
	// A borderless tinted chip per connection, linking to its access page: logo, name and any
	// limit in muted text. The tint shifts to the accent on hover instead of drawing an edge.
	logoLink: {
		display: "inline-flex",
		alignItems: "center",
		height: 22,
		paddingInline: 7,
		borderRadius: geometry.cornerSmall,
		backgroundColor: {
			default: `color-mix(in srgb, ${colors.text} 5%, transparent)`,
			":hover": `color-mix(in srgb, ${colors.action} 12%, transparent)`,
			":focus-visible": `color-mix(in srgb, ${colors.action} 12%, transparent)`,
		},
		textDecoration: "none",
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		color: {
			default: colors.text,
			":hover": colors.action,
			":focus-visible": colors.action,
		},
	},
	logo: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		whiteSpace: "nowrap",
	},
	chipLogo: {
		display: "block",
		flexShrink: 0,
		width: 14,
		height: 14,
		objectFit: "contain",
	},
	// --theme-dark is 0 or 1, so dark marks invert only in dark mode.
	chipLogoMono: { filter: "invert(calc(var(--theme-dark) * 0.92))" },
	// Meta: 12px muted sans with tabular numerals, quieter than the connection name.
	limited: {
		flexShrink: 0,
		color: colors.muted,
		fontFamily: geometry.fontSans,
		fontSize: 12,
		lineHeight: "16px",
		fontVariantNumeric: "tabular-nums",
	},
	// Hidden until the row is pointed at or holds focus; touch screens always show them.
	revealed: {
		opacity: {
			default: 0,
			[stylex.when.ancestor(":hover")]: 1,
			[stylex.when.ancestor(":focus-within")]: 1,
			":focus-visible": 1,
			"@media (pointer: coarse)": 1,
		},
		transitionProperty: {
			default: "opacity",
			"@media (prefers-reduced-motion: reduce)": "none",
		},
		transitionDuration: "120ms",
	},
	term: {
		flexShrink: 0,
		minWidth: 120,
		textAlign: "end",
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap",
	},
	grantAccess: {
		color: colors.action,
		padding: 0,
		borderStyle: "none",
		backgroundColor: "transparent",
		fontFamily: "inherit",
		fontSize: "inherit",
		fontWeight: "inherit",
		lineHeight: "inherit",
		cursor: "pointer",
	},
	meta: {
		marginTop: 2,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		minWidth: 0,
	},
	empty: { margin: 0, color: colors.muted },
});
