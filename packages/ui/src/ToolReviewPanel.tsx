import {
	ArrowLeftIcon,
	CaretRightIcon,
	CheckCircleIcon,
	CheckIcon,
	ShieldCheckIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ToolReviewClient } from "@toolstile/api/client";
import type {
	ToolChange,
	ToolReviewStatus,
	ToolReviewSummary,
} from "@toolstile/api/tool-review-contract";
import { type ReactNode, useRef, useState } from "react";
import { ConnectionMark } from "./ConnectionMark";
import { controls } from "./Control.styles";
import { formatFullDate, formatRelative } from "./format";
import { layout } from "./Layout.styles";
import { type DiffLine, lineDiff } from "./line-diff";
import { useLoaded, useScopedState } from "./ScopedState";
import { StatusBadge } from "./StatusBadge";
import { useToastFeedback } from "./Toast";
import {
	colors,
	elevation,
	geometry,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

/** Tool reviews page view from validated URL search parameters. */
export interface ToolReviewView {
	connection?: string;
}
type Api = Pick<
	ToolReviewClient,
	| "toolReviewSummary"
	| "toolReviewStatus"
	| "setToolReview"
	| "acceptToolChanges"
>;
type Summary = ToolReviewSummary["connections"][number];
/** The MCP connections the host knows, so rows can show each connection's logo. */
export type ToolReviewConnection = {
	id: string;
	url: string;
	logoUrl?: string | null;
};
/** Waiting changes first, then connections with review on, then the rest by name. */
const urgency = (connection: Summary) =>
	connection.enabled ? (connection.pending ? 0 : 1) : 2;
const byUrgency = (a: Summary, b: Summary) =>
	urgency(a) - urgency(b) ||
	b.pending - a.pending ||
	a.label.localeCompare(b.label);

const failure = (fallback: string) => (error: unknown) =>
	error instanceof Error ? error.message : fallback;
const waitingLabel = (count: number) =>
	`${count} ${count === 1 ? "change" : "changes"} waiting`;

/**
 * Review of new and changed upstream tool definitions. The list of connections and the selected
 * connection live in the URL; the review opens inline beside the list, never as a dialog.
 */
export function ToolReviewPanel({
	api,
	view,
	renderLink,
	scopeKey,
	connections: known = [],
}: {
	api: Api;
	view: ToolReviewView;
	connections?: ToolReviewConnection[];
	renderLink(link: {
		view: ToolReviewView;
		className: string;
		children: ReactNode;
		"aria-current"?: "page";
		"aria-label"?: string;
	}): ReactNode;
	scopeKey: string;
}) {
	const [revision, setRevision] = useScopedState(scopeKey, 0);
	const { current } = useLoaded<ToolReviewSummary>({
		scope: scopeKey,
		key: String(revision),
		load: () => api.toolReviewSummary(),
		failure: failure("Tool reviews could not be loaded."),
	});
	const connections = [...(current?.data?.connections ?? [])].sort(byUrgency);
	const marks = new Map(known.map((c) => [c.id, c]));
	const selected = view.connection;
	// Each row's switch: turning review on is the same call as the review's own button, which
	// needs no confirmation; turning it off asks first, with the review's own warning.
	const [switching, setSwitching] = useState<string>();
	const [confirmingOff, setConfirmingOff] = useState<string>();
	const [switchError, setSwitchError] = useState<{
		id: string;
		message: string;
	}>();
	const turnOn = (connection: Summary) => {
		setSwitching(connection.connectionId);
		setSwitchError(undefined);
		api
			.setToolReview({ connectionId: connection.connectionId, enabled: true })
			.then(() => setRevision((value) => value + 1))
			.catch((error: unknown) =>
				setSwitchError({
					id: connection.connectionId,
					message: failure(
						`Review could not be turned on for ${connection.label}.`,
					)(error),
				}),
			)
			.finally(() => setSwitching(undefined));
	};
	const turnOff = (connection: Summary) => {
		setSwitching(connection.connectionId);
		setSwitchError(undefined);
		api
			.setToolReview({ connectionId: connection.connectionId, enabled: false })
			.then(() => {
				setConfirmingOff(undefined);
				setRevision((value) => value + 1);
			})
			.catch((error: unknown) =>
				setSwitchError({
					id: connection.connectionId,
					message: failure(
						`Review could not be turned off for ${connection.label}.`,
					)(error),
				}),
			)
			.finally(() => setSwitching(undefined));
	};
	const active = connections.filter((connection) => connection.enabled);
	const off = connections.filter((connection) => !connection.enabled);
	const renderRow = (connection: Summary) => (
		<li
			key={connection.connectionId}
			{...stylex.props(styles.item, styles.itemSwitch)}
		>
			{renderLink({
				view: { connection: connection.connectionId },
				"aria-current":
					connection.connectionId === selected ? "page" : undefined,
				className:
					stylex.props(
						styles.row,
						connection.connectionId === selected && styles.rowSelected,
					).className ?? "",
				children: (
					<>
						<ConnectionMark
							label={connection.label}
							url={marks.get(connection.connectionId)?.url ?? ""}
							logoUrl={marks.get(connection.connectionId)?.logoUrl}
							size={32}
						/>
						<span {...stylex.props(styles.rowText)}>
							<span {...stylex.props(styles.rowLabel)}>{connection.label}</span>
							<span
								role={
									switchError?.id === connection.connectionId
										? "alert"
										: undefined
								}
								{...stylex.props(
									styles.rowDetail,
									switchError?.id === connection.connectionId &&
										styles.rowDetailError,
								)}
							>
								{switchError?.id === connection.connectionId
									? switchError.message
									: !connection.enabled
										? "New tools reach agents immediately"
										: connection.pending
											? "Held from agents until accepted"
											: "Every tool accepted"}
							</span>
						</span>
						<RowState connection={connection} compact={!!selected} />
						{/* Keeps room for the switch drawn beside the link. */}
						<span {...stylex.props(styles.switchSpace)} />
					</>
				),
			})}
			{/* Outside the row link: a control may not sit inside a link. */}
			<button
				type="button"
				role="switch"
				aria-checked={connection.enabled}
				aria-label={`Review for ${connection.label}`}
				title={connection.enabled ? "Turn off review" : "Turn on review"}
				disabled={switching === connection.connectionId}
				onClick={() =>
					connection.enabled
						? setConfirmingOff((value) =>
								value === connection.connectionId
									? undefined
									: connection.connectionId,
							)
						: turnOn(connection)
				}
				{...stylex.props(styles.switch, connection.enabled && styles.switchOn)}
			>
				<span
					aria-hidden="true"
					{...stylex.props(
						styles.switchThumb,
						connection.enabled && styles.switchThumbOn,
					)}
				/>
			</button>
			{confirmingOff === connection.connectionId && connection.enabled ? (
				<fieldset
					aria-label={`Turn off review for ${connection.label}`}
					{...stylex.props(styles.confirmOff)}
				>
					<p {...stylex.props(layout.meta, styles.confirmOffNote)}>
						Turning review off forgets every accepted version. All granted tools
						become available again as the server reports them.
					</p>
					<div {...stylex.props(layout.actions)}>
						<button
							type="button"
							disabled={switching === connection.connectionId}
							{...stylex.props(controls.button, controls.small, controls.quiet)}
							onClick={() => setConfirmingOff(undefined)}
						>
							Keep review on
						</button>
						<button
							type="button"
							disabled={switching === connection.connectionId}
							{...stylex.props(
								controls.button,
								controls.small,
								controls.danger,
							)}
							onClick={() => turnOff(connection)}
						>
							{switching === connection.connectionId
								? "Turning off…"
								: "Turn off review"}
						</button>
					</div>
				</fieldset>
			) : null}
		</li>
	);
	return (
		<div {...stylex.props(styles.page)}>
			<div
				{...stylex.props(styles.layout, !!selected && styles.layoutReviewing)}
			>
				<section
					aria-label="MCP connections"
					{...stylex.props(
						styles.panel,
						!!selected && styles.listWhileReviewing,
					)}
				>
					{current?.error ? (
						<div role="alert" {...stylex.props(styles.message)}>
							<p {...stylex.props(styles.errorText)}>{current.error}</p>
							<button
								type="button"
								{...stylex.props(controls.button)}
								onClick={() => setRevision((value) => value + 1)}
							>
								Try again
							</button>
						</div>
					) : !current ? (
						<p role="status" {...stylex.props(styles.message, layout.meta)}>
							Loading connections…
						</p>
					) : connections.length ? (
						<>
							{active.length ? (
								<>
									<h3
										{...stylex.props(
											styles.groupHeading,
											styles.groupHeadingFirst,
										)}
									>
										Review on
										<span {...stylex.props(styles.groupCount)}>
											· {active.length}
										</span>
									</h3>
									<ul {...stylex.props(styles.list)}>
										{active.map(renderRow)}
									</ul>
								</>
							) : null}
							{off.length ? (
								<>
									{/* Connections without review, grouped below the ones that need a decision. */}
									<h3
										{...stylex.props(
											styles.groupHeading,
											!active.length && styles.groupHeadingFirst,
										)}
									>
										Review off
										<span {...stylex.props(styles.groupCount)}>
											· {off.length}
										</span>
									</h3>
									<ul {...stylex.props(styles.list)}>{off.map(renderRow)}</ul>
								</>
							) : null}
						</>
					) : (
						<p {...stylex.props(styles.message, layout.muted)}>
							Add an MCP connection to review its tools.
						</p>
					)}
				</section>
				{selected ? (
					<ConnectionReview
						key={`${scopeKey}:${selected}`}
						api={api}
						connectionId={selected}
						label={
							connections.find((c) => c.connectionId === selected)?.label ??
							"MCP connection"
						}
						scopeKey={scopeKey}
						back={renderLink({
							view: {},
							className:
								stylex.props(
									controls.button,
									controls.small,
									controls.quiet,
									styles.back,
								).className ?? "",
							"aria-label": "Close review and show all connections",
							children: (
								<>
									<ArrowLeftIcon aria-hidden="true" />
									<span {...stylex.props(styles.backLabel)}>Connections</span>
								</>
							),
						})}
						onChanged={() => setRevision((value) => value + 1)}
					/>
				) : null}
			</div>
		</div>
	);
}

/** The row's right side: what to do next, in the order a reviewer needs it. */
function RowState({
	connection,
	compact,
}: {
	connection: Summary;
	compact: boolean;
}) {
	if (connection.enabled && connection.pending)
		return (
			<span
				{...stylex.props(
					controls.button,
					controls.small,
					styles.reviewCue,
					compact && styles.reviewCueCompact,
				)}
			>
				{compact
					? connection.pending.toLocaleString()
					: `Review ${connection.pending.toLocaleString()} ${connection.pending === 1 ? "change" : "changes"}`}
				<CaretRightIcon size={14} aria-hidden="true" />
			</span>
		);
	// Off rows say nothing here; their switch beside the link is the state.
	if (!connection.enabled) return null;
	return (
		<span {...stylex.props(styles.quietState)}>
			<CheckCircleIcon
				size={16}
				aria-hidden="true"
				{...stylex.props(styles.upToDateIcon)}
			/>
			Up to date
			<CaretRightIcon size={14} aria-hidden="true" />
		</span>
	);
}

function ConnectionBadge({ connection }: { connection: Summary }) {
	if (!connection.enabled) return <StatusBadge status="Off" tone="neutral" />;
	return connection.pending ? (
		<StatusBadge status={waitingLabel(connection.pending)} tone="warning" />
	) : (
		<StatusBadge status="Up to date" tone="good" />
	);
}

function ConnectionReview({
	api,
	connectionId,
	label,
	scopeKey,
	back,
	onChanged,
}: {
	api: Api;
	connectionId: string;
	label: string;
	scopeKey: string;
	back: ReactNode;
	onChanged(): void;
}) {
	const scope = `${scopeKey}:${connectionId}`;
	const notify = useToastFeedback(scope);
	const [revision, setRevision] = useScopedState(scope, 0);
	const [working, setWorking] = useScopedState<string | null>(scope, null);
	const [problem, setProblem] = useScopedState(scope, "");
	const [confirmingOff, setConfirmingOff] = useScopedState(scope, false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	// A synchronous guard so a double click cannot send a second change.
	const submitting = useRef(false);
	const { current: fresh, latest } = useLoaded<ToolReviewStatus>({
		scope,
		key: String(revision),
		load: () => api.toolReviewStatus({ connectionId }),
		failure: failure("This connection's review could not be loaded."),
	});
	const status = (fresh ?? latest)?.data;
	async function run(key: string, work: () => Promise<unknown>, done: string) {
		if (submitting.current) return;
		submitting.current = true;
		setWorking(key);
		setProblem("");
		try {
			await work();
			notify(done);
		} catch (error) {
			setProblem(
				error instanceof Error ? error.message : "The change was not saved.",
			);
		} finally {
			submitting.current = false;
			setWorking(null);
			setConfirmingOff(false);
			setRevision((value) => value + 1);
			onChanged();
			headingRef.current?.focus({ preventScroll: true });
		}
	}
	const accept = (changes: ToolChange[]) =>
		run(
			changes.length === 1 ? changes[0].digest : "all",
			() =>
				api.acceptToolChanges({
					connectionId,
					tools: changes.map(({ name, digest }) => ({ name, digest })),
				}),
			changes.length === 1
				? `Accepted ${changes[0].name}. Agents with access can use it again.`
				: `Accepted ${changes.length} tool changes.`,
		);
	const busy = !!working || !fresh?.data;
	return (
		<section
			aria-labelledby={`tool-review-${connectionId}`}
			{...stylex.props(styles.panel, styles.review)}
		>
			<header {...stylex.props(styles.reviewHeader)}>
				{back}
				<h2
					ref={headingRef}
					tabIndex={-1}
					id={`tool-review-${connectionId}`}
					{...stylex.props(styles.reviewTitle)}
				>
					{label}
				</h2>
				{status ? (
					<ConnectionBadge
						connection={{
							connectionId,
							label,
							enabled: status.enabled,
							pending: status.pendingCount,
						}}
					/>
				) : null}
			</header>
			{!status && latest?.error ? (
				<div role="alert" {...stylex.props(styles.body)}>
					<p {...stylex.props(styles.errorText)}>{latest.error}</p>
				</div>
			) : !status ? (
				<p role="status" {...stylex.props(styles.body, layout.meta)}>
					Loading review…
				</p>
			) : (
				<div {...stylex.props(styles.body)}>
					{status.enabled ? (
						<p {...stylex.props(layout.muted)}>
							{status.reviewedCount}{" "}
							{status.reviewedCount === 1 ? "tool" : "tools"} reviewed. Review
							has been on since{" "}
							<time
								dateTime={status.enabledAt ?? undefined}
								title={status.enabledAt ? formatFullDate(status.enabledAt) : ""}
							>
								{status.enabledAt ? formatRelative(status.enabledAt) : "now"}
							</time>
							. Changes show up here when an agent lists or calls tools, or when
							you refresh this connection's tools.
						</p>
					) : (
						<div {...stylex.props(styles.explain)}>
							<p {...stylex.props(styles.paragraph)}>
								Turning review on accepts the tools this connection has now.
								After that, a new tool, or a tool whose name, description,
								inputs, outputs or hints change, is hidden from agents and
								refused until it is accepted here. That includes tools allowed
								through "All, including new".
							</p>
							<p {...stylex.props(styles.paragraph, layout.muted)}>
								Review compares the definition the server reports. It cannot
								tell when a tool behaves differently behind an unchanged
								definition.
							</p>
						</div>
					)}
					{problem ? (
						<p role="alert" {...stylex.props(styles.errorText)}>
							{problem}
						</p>
					) : null}
					{!status.canReview ? (
						<p {...stylex.props(layout.meta)}>
							Only people who manage this connection can change its review.
						</p>
					) : !status.enabled ? (
						<div {...stylex.props(layout.actions)}>
							<button
								type="button"
								disabled={busy}
								{...stylex.props(controls.button, controls.primary)}
								onClick={() =>
									void run(
										"on",
										() => api.setToolReview({ connectionId, enabled: true }),
										`Review is on for ${label}.`,
									)
								}
							>
								<ShieldCheckIcon aria-hidden="true" />
								{working === "on" ? "Turning on…" : "Turn on review"}
							</button>
						</div>
					) : null}
					{status.enabled && status.pending.length ? (
						<div {...stylex.props(styles.changes)}>
							<div {...stylex.props(styles.changesHeader)}>
								<h3 {...stylex.props(styles.subheading)}>
									{waitingLabel(status.pendingCount)}
								</h3>
								{status.canReview && status.pending.length > 1 ? (
									<button
										type="button"
										disabled={busy}
										{...stylex.props(controls.button, controls.small)}
										onClick={() => void accept(status.pending)}
									>
										{working === "all" ? "Accepting…" : "Accept all"}
									</button>
								) : null}
							</div>
							{status.pendingCount > status.pending.length ? (
								<p {...stylex.props(layout.meta)}>
									Showing the {status.pending.length} most recent. Accept these
									to see the rest.
								</p>
							) : null}
							<ul {...stylex.props(styles.list)}>
								{status.pending.map((change) => (
									<li key={change.digest} {...stylex.props(styles.change)}>
										<div {...stylex.props(styles.changeHeader)}>
											<code {...stylex.props(styles.toolName)}>
												{change.name}
											</code>
											<StatusBadge
												status={change.previous ? "Changed" : "New"}
												tone={change.previous ? "warning" : "action"}
											/>
											<span
												title={formatFullDate(change.observedAt)}
												{...stylex.props(styles.time)}
											>
												Seen {formatRelative(change.observedAt)}
											</span>
											{status.canReview ? (
												<button
													type="button"
													disabled={busy}
													{...stylex.props(
														controls.button,
														controls.small,
														styles.acceptButton,
													)}
													onClick={() => void accept([change])}
												>
													<CheckIcon aria-hidden="true" />
													{working === change.digest ? "Accepting…" : "Accept"}
												</button>
											) : null}
										</div>
										<Definition change={change} />
									</li>
								))}
							</ul>
						</div>
					) : status.enabled ? (
						<p {...stylex.props(layout.muted)}>
							Nothing is waiting for review.
						</p>
					) : null}
					{status.enabled && status.canReview ? (
						<div {...stylex.props(styles.off)}>
							{confirmingOff ? (
								<>
									<p {...stylex.props(layout.meta, styles.offNote)}>
										Turning review off forgets every accepted version. All
										granted tools become available again as the server reports
										them.
									</p>
									<div {...stylex.props(layout.actions)}>
										<button
											type="button"
											disabled={busy}
											{...stylex.props(controls.button, controls.quiet)}
											onClick={() => setConfirmingOff(false)}
										>
											Keep review on
										</button>
										<button
											type="button"
											disabled={busy}
											{...stylex.props(controls.button, controls.danger)}
											onClick={() =>
												void run(
													"off",
													() =>
														api.setToolReview({ connectionId, enabled: false }),
													`Review is off for ${label}.`,
												)
											}
										>
											{working === "off" ? "Turning off…" : "Turn off review"}
										</button>
									</div>
								</>
							) : (
								<button
									type="button"
									disabled={busy}
									{...stylex.props(
										controls.button,
										controls.small,
										controls.quiet,
									)}
									onClick={() => setConfirmingOff(true)}
								>
									Turn off review
								</button>
							)}
						</div>
					) : null}
				</div>
			)}
		</section>
	);
}

/** The new definition, as a diff against the accepted one when there is one. */
function Definition({ change }: { change: ToolChange }) {
	const [full, setFull] = useState(false);
	if (!change.snapshot)
		return (
			<p {...stylex.props(layout.meta)}>
				This definition is too large to show. Accept it only if you trust the
				server.
			</p>
		);
	const diff =
		change.previous?.snapshot && !full
			? lineDiff(change.previous.snapshot, change.snapshot)
			: undefined;
	return (
		<div {...stylex.props(styles.definition)}>
			{diff ? (
				<DiffBlock lines={diff} label={`Changes to ${change.name}`} />
			) : (
				<section aria-label={`Definition of ${change.name}`}>
					<pre {...stylex.props(styles.code)}>{change.snapshot}</pre>
				</section>
			)}
			{change.previous && !change.previous.snapshot ? (
				<p {...stylex.props(layout.meta)}>
					The accepted version was too large to keep, so only the new one is
					shown.
				</p>
			) : change.previous?.snapshot ? (
				<button
					type="button"
					{...stylex.props(
						controls.button,
						controls.small,
						controls.quiet,
						styles.definitionToggle,
					)}
					onClick={() => setFull((value) => !value)}
				>
					{full ? "Show changes" : "Show full definition"}
				</button>
			) : null}
		</div>
	);
}

function DiffBlock({ lines, label }: { lines: DiffLine[]; label: string }) {
	return (
		<section aria-label={label}>
			<pre {...stylex.props(styles.code)}>
				{lines.map((line, index) => (
					<span
						// Lines repeat; their position is their identity in this fixed list.
						// oxlint-disable-next-line react/no-array-index-key -- static diff output
						key={index}
						{...stylex.props(
							styles.line,
							line.kind === "added" && styles.added,
							line.kind === "removed" && styles.removed,
						)}
					>
						<span aria-hidden="true" {...stylex.props(styles.marker)}>
							{line.kind === "added"
								? "+"
								: line.kind === "removed"
									? "−"
									: " "}
						</span>
						<span {...stylex.props(layout.visuallyHidden)}>
							{line.kind === "added"
								? "Added: "
								: line.kind === "removed"
									? "Removed: "
									: ""}
						</span>
						{line.text}
						{"\n"}
					</span>
				))}
			</pre>
		</section>
	);
}

const mobile = "@media (max-width: 760px)";
const wide = "@media (min-width: 1100px)";

const styles = stylex.create({
	layout: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr)",
		gap: space.s4,
		alignItems: "start",
		fontFamily: geometry.fontSans,
	},
	layoutReviewing: {
		gridTemplateColumns: {
			default: "minmax(0, 1fr)",
			[wide]: "minmax(0, 2fr) minmax(0, 3fr)",
		},
	},
	listWhileReviewing: { display: { default: "block", [mobile]: "none" } },
	panel: {
		minWidth: 0,
		backgroundColor: colors.surface,
		color: colors.text,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
	},
	page: { display: "grid", gap: space.s3, minWidth: 0 },
	list: { listStyle: "none", margin: 0, padding: 0 },
	item: {
		borderBottomWidth: { default: 1, ":last-child": 0 },
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	itemSwitch: { position: "relative" },
	switchSpace: { flexShrink: 0, width: 36 },
	// A 36x20 switch on the row's right edge, aligned with the buttons above it.
	switch: {
		position: "absolute",
		// Centred on the 56px row, so an open confirmation below never moves it.
		top: 28,
		insetInlineEnd: { default: space.s4, [mobile]: space.s3 },
		transform: "translateY(-50%)",
		display: "flex",
		alignItems: "center",
		width: 36,
		height: 20,
		padding: 2,
		borderWidth: 0,
		borderRadius: 999,
		// A light track at rest: #d4d7dd in light, #474b55 in dark (--theme-dark is 0 or 1).
		backgroundColor: {
			default:
				"color-mix(in srgb, #474b55 calc(var(--theme-dark) * 100%), #d4d7dd)",
			":hover":
				"color-mix(in srgb, #4a4e58 calc(var(--theme-dark) * 100%), #c2c6ce)",
			":focus-visible":
				"color-mix(in srgb, #4a4e58 calc(var(--theme-dark) * 100%), #c2c6ce)",
		},
		cursor: { default: "pointer", ":disabled": "progress" },
		opacity: { default: 1, ":disabled": 0.6 },
		outlineOffset: 2,
		transitionProperty: "background-color",
		transitionDuration: "120ms",
		"::before": {
			// A 32px (44px on touch) target around the drawn switch.
			content: '""',
			position: "absolute",
			inset: { default: -6, "@media (pointer: coarse)": -12 },
		},
	},
	switchThumb: {
		display: "block",
		width: 16,
		height: 16,
		borderRadius: 999,
		backgroundColor: "#fff",
		boxShadow: "0 1px 2px rgb(0 0 0 / 0.25)",
		transitionProperty: "transform",
		transitionDuration: "120ms",
	},
	switchOn: {
		backgroundColor: {
			default: colors.actionFill,
			":hover": colors.actionFillHover,
			":focus-visible": colors.actionFillHover,
		},
	},
	switchThumbOn: { transform: "translateX(16px)" },
	// The turn-off confirmation, under the row's text column (32px mark + 12px gap).
	// A fieldset groups the confirmation; its browser border, margin and min-width are reset.
	confirmOff: {
		display: "grid",
		gap: space.s2,
		margin: 0,
		borderWidth: 0,
		minWidth: 0,
		padding: {
			default: `0 ${space.s4} ${space.s3} 60px`,
			[mobile]: `0 ${space.s3} ${space.s3}`,
		},
	},
	confirmOffNote: { margin: 0, maxWidth: "64ch" },
	row: {
		display: "flex",
		alignItems: "center",
		gap: space.s3,
		minHeight: 56,
		boxSizing: "border-box",
		padding: {
			default: `8px ${space.s4}`,
			[mobile]: `8px ${space.s3}`,
		},
		color: colors.text,
		textDecoration: "none",
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		outlineOffset: -2,
	},
	rowSelected: {
		backgroundColor: {
			default: colors.actionTint,
			":hover": colors.actionTint,
			":focus-visible": colors.actionTint,
		},
	},
	rowText: { display: "grid", flex: 1, minWidth: 0 },
	rowLabel: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		fontWeight: 500,
	},
	rowDetailError: { color: colors.bad },
	rowDetail: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
	},
	// The waiting row's call to action: a tinted cobalt button (10% cobalt fill, cobalt text), so
	// it leads the row without competing with the solid cobalt switch beside it.
	reviewCue: {
		gap: 6,
		flexShrink: 0,
		height: 28,
		minHeight: 28,
		borderColor: "transparent",
		backgroundColor: colors.actionTint,
		backgroundImage: "none",
		boxShadow: "none",
		color: colors.action,
		marginInlineEnd: space.s2,
		paddingInlineStart: space.s3,
		paddingInlineEnd: space.s2,
		fontWeight: 500,
		whiteSpace: "nowrap",
		pointerEvents: "none",
	},
	reviewCueCompact: { paddingInlineStart: space.s2 },

	// "Review off · 4": a quiet subheading inside the same container.
	groupHeading: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		margin: 0,
		height: 32,
		boxSizing: "border-box",
		paddingInline: { default: space.s4, [mobile]: space.s3 },
		backgroundColor: colors.band,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: colors.line,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
	},
	groupHeadingFirst: {
		borderTopWidth: 0,
		borderStartStartRadius: geometry.corner,
		borderStartEndRadius: geometry.corner,
	},
	groupCount: { fontWeight: 500, fontVariantNumeric: "tabular-nums" },
	quietState: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		flexShrink: 0,
		height: 28,
		boxSizing: "border-box",
		paddingInline: space.s2,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		whiteSpace: "nowrap",
	},
	upToDateIcon: { color: colors.good },
	message: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: space.s3,
		margin: 0,
		padding: { default: space.s4, [mobile]: space.s3 },
	},
	review: {
		position: { default: "static", [wide]: "sticky" },
		top: "var(--page-padding)",
	},
	reviewHeader: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: `${space.s1} ${space.s2}`,
		padding: {
			default: `6px ${space.s3} 6px 6px`,
			[mobile]: `6px ${space.s2} 6px ${space.s1}`,
		},
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	back: { textDecoration: "none" },
	backLabel: { display: { default: "none", [mobile]: "inline" } },
	reviewTitle: {
		flex: "1 1 0",
		minWidth: 0,
		margin: 0,
		fontSize: text.sectionTitle,
		lineHeight: text.sectionTitleLeading,
		fontWeight: 500,
		overflowWrap: "anywhere",
	},
	body: {
		display: "grid",
		gap: space.s3,
		padding: space.s3,
		minWidth: 0,
	},
	explain: { display: "grid", gap: space.s2 },
	paragraph: {
		margin: 0,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	changes: { display: "grid", gap: space.s2, minWidth: 0 },
	changesHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: space.s2,
	},
	subheading: {
		margin: 0,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 500,
	},
	change: {
		display: "grid",
		gap: space.s2,
		paddingBlock: space.s2,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: colors.line,
		minWidth: 0,
	},
	changeHeader: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: space.s2,
	},
	toolName: {
		fontFamily: geometry.fontMono,
		fontSize: text.body,
		overflowWrap: "anywhere",
	},
	time: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	acceptButton: { marginInlineStart: "auto" },
	definition: { display: "grid", gap: space.s2, justifyItems: "stretch" },
	definitionToggle: { justifySelf: "start" },
	code: {
		boxSizing: "border-box",
		width: "100%",
		margin: 0,
		maxHeight: "min(420px, 50dvh)",
		overflow: "auto",
		padding: space.s3,
		borderRadius: geometry.corner,
		backgroundColor: colors.insetTint,
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere",
	},
	line: { display: "block" },
	added: { backgroundColor: colors.goodTint },
	removed: { backgroundColor: colors.badTint },
	marker: {
		display: "inline-block",
		width: "1.5ch",
		color: colors.muted,
		userSelect: "none",
	},
	off: { display: "grid", gap: space.s2, justifyItems: "start" },
	offNote: { margin: 0 },
	errorText: {
		margin: 0,
		color: colors.bad,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		overflowWrap: "anywhere",
	},
});
