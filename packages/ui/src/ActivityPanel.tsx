import {
	ClockCounterClockwiseIcon,
	MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ManagementClient } from "@toolstile/api/client";
import type { ActivityOutcomeFilter, Snapshot } from "@toolstile/api/contract";
import { Fragment, useEffect, useRef } from "react";
import { controls } from "./Control.styles";
import { dashboardStyles as styles } from "./Dashboard.styles";
import { DebugPanel } from "./DebugPanel";
import { formatFullDate } from "./format";
import { layout } from "./Layout.styles";
import { EmptyState, Pagination, Tabs } from "./Primitives";
import { StatusBadge, type StatusTone } from "./StatusBadge";
import { colors, elevation, geometry, space, text } from "./tokens.stylex";

/** Activity page view from validated URL search parameters. */
export interface ActivityView {
	tab?: "debug";
	outcome?: ActivityOutcomeFilter;
	query?: string;
	page?: number;
	/** `all` also lists requests the dashboard made, such as checks; absent lists agents' only. */
	source?: "all";
	/** The request to show: its page opens and its row is marked and scrolled into view. */
	request?: string;
}
const ACTIVITY_PAGE_SIZE = 25;
/** Requests at or above this duration get a small amber dot. */
const SLOW_MS = 10_000;

/** Activity outcomes as badges; unknown outcomes keep their recorded text. */
const outcomes: Record<string, { label: string; tone: StatusTone }> = {
	forwarded: { label: "Forwarded", tone: "good" },
	denied: { label: "Denied", tone: "bad" },
	upstream_error: { label: "Upstream error", tone: "bad" },
	error: { label: "Error", tone: "bad" },
	approval_required: { label: "Needs approval", tone: "action" },
	unreviewed: { label: "Held for review", tone: "warning" },
};
/** Refused by access rules, including a tool held until its changed definition is reviewed. */
const refused = (outcome: string) =>
	outcome === "denied" || outcome === "unreviewed";
const filters: {
	id: ActivityOutcomeFilter | "all";
	label: string;
	matches(outcome: string): boolean;
}[] = [
	{ id: "all", label: "All", matches: () => true },
	{
		id: "forwarded",
		label: "Forwarded",
		matches: (outcome) => outcome === "forwarded",
	},
	{ id: "denied", label: "Denied", matches: refused },
	{
		id: "errors",
		label: "Errors",
		matches: (outcome) => outcome === "upstream_error" || outcome === "error",
	},
	{
		id: "approval",
		label: "Needs approval",
		matches: (outcome) => outcome === "approval_required",
	},
];
function OutcomeBadge({ outcome }: { outcome: string }) {
	const known = outcomes[outcome];
	return (
		<StatusBadge status={outcome} tone={known?.tone ?? "neutral"}>
			{known?.label ?? outcome.replaceAll("_", " ")}
		</StatusBadge>
	);
}

const clock = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});
const day = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});
/** A log reads by clock time; the day is its group row, and the full date shows on hover. */
function Timestamp({ value }: { value: string }) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return <span>—</span>;
	return (
		<time
			dateTime={date.toISOString()}
			title={formatFullDate(date)}
			{...stylex.props(local.time)}
		>
			{clock.format(date)}
		</time>
	);
}
/** The day group a request belongs to: Today, Yesterday, or its date. */
function dayLabel(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown date";
	const start = (d: Date) =>
		new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((start(new Date()) - start(date)) / 86_400_000);
	if (days === 0) return "Today";
	if (days === 1) return "Yesterday";
	return day.format(date);
}
function formatDuration(ms: number) {
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/**
 * Figures over the loaded recent requests, so the summary never claims more than it shows.
 * They complement the outcome filter, whose counts are on its own segments.
 */
function ActivitySummary({ activity }: { activity: Snapshot["activity"] }) {
	const durations = activity
		.map((entry) => entry.durationMs)
		.sort((a, b) => a - b);
	const p95 =
		durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
	const errors = activity.filter(
		(entry) => entry.outcome === "error" || entry.outcome === "upstream_error",
	).length;
	const forwarded = activity.filter(
		(entry) => entry.outcome === "forwarded",
	).length;
	const rate = activity.length
		? Math.round((forwarded / activity.length) * 100)
		: 0;
	const items = [
		{ label: "Recent requests", value: activity.length.toLocaleString() },
		{ label: "Success rate", value: `${rate}%` },
		{ label: "p95 duration", value: formatDuration(p95) },
		{ label: "Errors", value: errors.toLocaleString() },
	];
	return (
		<dl
			aria-label={`Across the ${activity.length} most recent requests`}
			title={`Across the ${activity.length} most recent requests`}
			{...stylex.props(local.stats)}
		>
			{items.map((item) => (
				<div key={item.label} {...stylex.props(local.stat)}>
					<dt {...stylex.props(local.statLabel)}>{item.label}</dt>
					<dd {...stylex.props(local.statValue)}>{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** The source filter: agents' own requests, or those plus the dashboard's checks. */
const sources = [
	{ id: "agents", label: "Agents" },
	{ id: "all", label: "All" },
] as const;

/**
 * Activity page: recent requests with source and outcome filters, search and pages, and debug
 * capture in its own tab. The view lives in the URL. Requests the dashboard made, such as
 * connection checks, are hidden unless the view asks for all sources.
 */
export function ActivityPanel({
	data,
	api,
	view,
	onViewChange,
	debug,
	onNavigate,
}: {
	data: Snapshot;
	api: ManagementClient;
	view: ActivityView;
	/** `replace` is set while typing a search so each keystroke does not add history. */
	onViewChange(view: ActivityView, replace?: boolean): void;
	debug?: { selectedPayloadId?: string; onSelectPayload(id?: string): void };
	onNavigate(section: string): void;
}) {
	const tab = debug && view.tab === "debug" ? "debug" : "requests";
	const outcome = view.outcome ?? "all";
	const query = view.query ?? "";
	const needle = query.trim().toLowerCase();
	const filter = filters.find((item) => item.id === outcome) ?? filters[0];
	const requested = view.request
		? data.activity.find((entry) => entry.id === view.request)
		: undefined;
	// A linked request the dashboard made is shown with every source.
	const source =
		view.source === "all" || requested?.origin === "dashboard"
			? "all"
			: "agents";
	const agentActivity = data.activity.filter(
		(entry) => entry.origin !== "dashboard",
	);
	const sourced = source === "all" ? data.activity : agentActivity;
	const hidden = data.activity.length - sourced.length;
	const matching = sourced.filter(
		(entry) =>
			filter.matches(entry.outcome) &&
			(!needle ||
				[entry.agent, entry.connection, entry.method, entry.target ?? ""].some(
					(value) => value.toLowerCase().includes(needle),
				)),
	);
	const pages = Math.max(1, Math.ceil(matching.length / ACTIVITY_PAGE_SIZE));
	const requestedIndex = requested
		? matching.findIndex((entry) => entry.id === requested.id)
		: -1;
	const page = Math.min(
		view.page ??
			(requestedIndex >= 0
				? Math.floor(requestedIndex / ACTIVITY_PAGE_SIZE) + 1
				: 1),
		pages,
	);
	const rows = matching.slice(
		(page - 1) * ACTIVITY_PAGE_SIZE,
		page * ACTIVITY_PAGE_SIZE,
	);
	// Every change below leaves out `request`, so changing the view lets go of a linked request.
	const sourceView = source === "all" ? ("all" as const) : undefined;
	const listView = {
		outcome: view.outcome,
		query: view.query,
		source: sourceView,
	};
	const showAll = () =>
		onViewChange({ outcome: view.outcome, query: view.query, source: "all" });
	// Bring a linked request into view once per request, when its row first renders.
	const requestedRow = useRef<HTMLTableRowElement>(null);
	const scrolledTo = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!view.request || scrolledTo.current === view.request) return;
		if (!requestedRow.current) return;
		scrolledTo.current = view.request;
		requestedRow.current.scrollIntoView({ block: "center" });
	});
	return (
		<div {...stylex.props(local.root)}>
			{debug ? (
				<Tabs
					label="Activity views"
					value={tab}
					items={[
						{ id: "requests", label: "Requests" },
						{ id: "debug", label: "Debug capture" },
					]}
					onChange={(next) =>
						onViewChange(next === "debug" ? { tab: "debug" } : listView)
					}
				/>
			) : null}
			{tab === "debug" && debug ? (
				<DebugPanel
					api={api}
					agents={data.agents}
					connections={data.connections}
					selectedPayloadId={debug.selectedPayloadId}
					onSelectPayload={debug.onSelectPayload}
				/>
			) : sourced.length ? (
				<>
					<ActivitySummary activity={sourced} />
					<section aria-label="Requests" {...stylex.props(local.panel)}>
						<div {...stylex.props(local.toolbar)}>
							<nav aria-label="Source" {...stylex.props(local.filters)}>
								{sources.map((item) => {
									const selected = item.id === source;
									const total =
										item.id === "all"
											? data.activity.length
											: agentActivity.length;
									return (
										<button
											key={item.id}
											type="button"
											aria-current={selected ? "page" : undefined}
											{...stylex.props(
												local.segment,
												selected && local.segmentSelected,
											)}
											onClick={() =>
												onViewChange({
													outcome: view.outcome,
													query: view.query,
													source: item.id === "all" ? "all" : undefined,
												})
											}
										>
											{item.label}
											<span
												{...stylex.props(
													local.segmentCount,
													selected && local.segmentCountSelected,
												)}
											>
												{total}
											</span>
										</button>
									);
								})}
							</nav>
							<nav aria-label="Outcome" {...stylex.props(local.filters)}>
								{filters.map((item) => {
									const selected = item.id === outcome;
									const total = sourced.filter((entry) =>
										item.matches(entry.outcome),
									).length;
									return (
										<button
											key={item.id}
											type="button"
											aria-current={selected ? "page" : undefined}
											{...stylex.props(
												local.segment,
												selected && local.segmentSelected,
											)}
											onClick={() =>
												onViewChange({
													outcome: item.id === "all" ? undefined : item.id,
													query: view.query,
													source: sourceView,
												})
											}
										>
											{item.label}
											<span
												{...stylex.props(
													local.segmentCount,
													selected && local.segmentCountSelected,
												)}
											>
												{total}
											</span>
										</button>
									);
								})}
							</nav>
							<label {...stylex.props(local.search)}>
								<span {...stylex.props(layout.visuallyHidden)}>
									Search by agent, MCP connection or operation
								</span>
								<MagnifyingGlassIcon
									size={16}
									aria-hidden="true"
									{...stylex.props(local.searchIcon)}
								/>
								<input
									type="search"
									value={query}
									maxLength={100}
									placeholder="Search agent, MCP or operation"
									{...stylex.props(controls.input, local.searchInput)}
									onChange={(event) =>
										onViewChange(
											{
												outcome: view.outcome,
												query: event.target.value || undefined,
												source: sourceView,
											},
											true,
										)
									}
								/>
							</label>
						</div>
						{rows.length ? (
							<div {...stylex.props(local.scroll)}>
								<table {...stylex.props(styles.table, local.table)}>
									<thead {...stylex.props(styles.tableHead)}>
										<tr>
											<th
												scope="col"
												{...stylex.props(
													styles.tableHeader,
													local.cell,
													local.colTime,
												)}
											>
												Time
											</th>
											<th
												scope="col"
												{...stylex.props(styles.tableHeader, local.cell)}
											>
												Agent / MCP connection
											</th>
											<th
												scope="col"
												{...stylex.props(styles.tableHeader, local.cell)}
											>
												Operation
											</th>
											<th
												scope="col"
												{...stylex.props(
													styles.tableHeader,
													local.cell,
													local.colOutcome,
												)}
											>
												Outcome
											</th>
											<th
												scope="col"
												{...stylex.props(
													styles.tableHeader,
													local.cell,
													styles.alignEnd,
													local.colDuration,
												)}
											>
												Duration
											</th>
										</tr>
									</thead>
									<tbody>
										{rows.map((e, index) => {
											const group = dayLabel(e.createdAt);
											const newGroup =
												index === 0 ||
												group !== dayLabel(rows[index - 1].createdAt);
											const current = e.id === requested?.id;
											return (
												<Fragment key={e.id}>
													{newGroup ? (
														<tr>
															<th
																colSpan={5}
																scope="colgroup"
																{...stylex.props(local.groupRow)}
															>
																{group}
															</th>
														</tr>
													) : null}
													<tr
														ref={current ? requestedRow : undefined}
														aria-current={current ? "true" : undefined}
														{...stylex.props(current && local.rowCurrent)}
													>
														<td
															{...stylex.props(
																styles.tableCell,
																local.cell,
																styles.numeric,
																local.nowrap,
															)}
														>
															<Timestamp value={e.createdAt} />
														</td>
														<td {...stylex.props(styles.tableCell, local.cell)}>
															<span
																title={`${e.agent} · ${e.connection}`}
																{...stylex.props(local.truncate)}
															>
																<span {...stylex.props(local.agent)}>
																	{e.agent}
																</span>
																<span {...stylex.props(local.detail)}>
																	{" · "}
																	{e.connection}
																</span>
															</span>
														</td>
														<td {...stylex.props(styles.tableCell, local.cell)}>
															<span
																title={
																	e.target
																		? `${e.method} · ${e.target}`
																		: e.method
																}
																{...stylex.props(local.truncate)}
															>
																<code {...stylex.props(local.code)}>
																	<span {...stylex.props(local.muted)}>
																		{e.method}
																	</span>
																	{e.target ? (
																		<>
																			<span {...stylex.props(local.muted)}>
																				{" · "}
																			</span>
																			{e.target}
																		</>
																	) : null}
																</code>
															</span>
														</td>
														<td
															{...stylex.props(
																styles.tableCell,
																local.cell,
																local.nowrap,
															)}
														>
															<OutcomeBadge outcome={e.outcome} />
														</td>
														<td
															{...stylex.props(
																styles.tableCell,
																local.cell,
																styles.numeric,
																styles.alignEnd,
																local.nowrap,
															)}
														>
															<span
																{...stylex.props(
																	local.duration,
																	e.durationMs >= SLOW_MS && local.durationSlow,
																)}
																title={
																	e.durationMs >= SLOW_MS
																		? "Slow request: over 10 s"
																		: undefined
																}
															>
																{formatDuration(e.durationMs)}
															</span>
														</td>
													</tr>
												</Fragment>
											);
										})}
									</tbody>
								</table>
							</div>
						) : (
							<p {...stylex.props(local.message)}>
								{needle
									? `No requests match “${query.trim()}”.`
									: "No requests with this outcome."}
							</p>
						)}
						{matching.length > ACTIVITY_PAGE_SIZE ? (
							<div {...stylex.props(local.pagination)}>
								<Pagination
									page={page}
									total={matching.length}
									size={ACTIVITY_PAGE_SIZE}
									onChange={(next) =>
										onViewChange({
											...listView,
											page: next > 1 ? next : undefined,
										})
									}
								/>
							</div>
						) : null}
						{(matching.length && matching.length <= ACTIVITY_PAGE_SIZE) ||
						hidden ? (
							<div {...stylex.props(local.footnote)}>
								{matching.length && matching.length <= ACTIVITY_PAGE_SIZE ? (
									<span>
										{matching.length === sourced.length
											? `Showing all ${sourced.length.toLocaleString()} recent ${sourced.length === 1 ? "request" : "requests"}`
											: `Showing ${matching.length.toLocaleString()} of ${sourced.length.toLocaleString()} recent requests`}
									</span>
								) : null}
								{hidden ? (
									<span {...stylex.props(local.hidden)}>
										{`${hidden.toLocaleString()} dashboard ${hidden === 1 ? "check" : "checks"} hidden`}
										<button
											type="button"
											{...stylex.props(local.textButton)}
											onClick={showAll}
										>
											Show all
										</button>
									</span>
								) : null}
							</div>
						) : null}
					</section>
				</>
			) : data.activity.length ? (
				<EmptyState
					icon={ClockCounterClockwiseIcon}
					title="No agent has made a request yet"
					action={
						<button
							{...stylex.props(controls.button)}
							type="button"
							onClick={showAll}
						>
							Show all
						</button>
					}
				>
					Requests the dashboard made, such as connection checks, are hidden.
				</EmptyState>
			) : (
				<EmptyState
					icon={ClockCounterClockwiseIcon}
					action={
						<button
							{...stylex.props(controls.button)}
							type="button"
							onClick={() => onNavigate("connections")}
						>
							Go to connections
						</button>
					}
				>
					Requests appear here once an agent or a verification reaches a server
				</EmptyState>
			)}
		</div>
	);
}

const mobile = "@media (max-width: 640px)";
const narrow = "@media (max-width: 760px)";
const local = stylex.create({
	root: { display: "grid", gap: space.s4, minWidth: 0 },
	// One framed list: filters, rows and pager share the frame.
	panel: {
		minWidth: 0,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
		backgroundColor: colors.surface,
		// Clips the last row's divider so the table ends at the frame's rounded edge.
		overflow: "hidden",
	},
	toolbar: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: space.s3,
		paddingInline: { default: space.s4, [mobile]: space.s3 },
		paddingBlock: space.s2,
		minHeight: 48,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	// A compact segmented control: these filter the rows, so they sit below the page tabs.
	filters: {
		display: "flex",
		gap: 2,
		padding: 2,
		width: "fit-content",
		maxWidth: "100%",
		overflowX: "auto",
		borderRadius: geometry.corner,
		backgroundColor: colors.insetTint,
		scrollbarWidth: "none",
	},
	segment: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		flexShrink: 0,
		minHeight: { default: 28, "@media (pointer: coarse)": 44 },
		paddingInline: 10,
		borderWidth: 0,
		borderRadius: geometry.cornerSmall,
		backgroundColor: "transparent",
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		fontWeight: 400,
		whiteSpace: "nowrap",
		cursor: "pointer",
		outline: "none",
	},
	segmentSelected: {
		fontWeight: 500,
		backgroundColor: colors.surface,
		color: {
			default: colors.text,
			":hover": colors.text,
			":focus-visible": colors.text,
		},
		boxShadow: elevation.low,
	},
	segmentCount: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 400,
		fontVariantNumeric: "tabular-nums",
		opacity: 0.8,
	},
	segmentCountSelected: { opacity: 1 },
	search: {
		position: "relative",
		display: "block",
		flex: { default: "0 1 260px", [narrow]: "1 1 100%" },
		order: { default: 0, [narrow]: -1 },
		minWidth: 0,
		marginInlineStart: { default: "auto", [narrow]: 0 },
	},
	searchIcon: {
		position: "absolute",
		insetInlineStart: 10,
		top: "50%",
		transform: "translateY(-50%)",
		color: colors.muted,
		pointerEvents: "none",
	},
	searchInput: {
		paddingInlineStart: space.s8,
		boxSizing: "border-box",
		height: { default: 32, "@media (pointer: coarse)": 44 },
		minHeight: 0,
		paddingBlock: 0,
	},
	scroll: { overflowX: "auto", maxWidth: "100%", marginBottom: -1 },
	// Narrow screens scroll the table sideways instead of wrapping every cell.
	table: { minWidth: 640, fontSize: text.body, lineHeight: text.bodyLeading },
	nowrap: { whiteSpace: "nowrap" },
	time: { fontVariantNumeric: "tabular-nums", color: colors.muted },
	// A day's heading inside the table: the shared band style, 32px.
	groupRow: {
		height: 32,
		paddingBlock: 0,
		paddingInline: { default: space.s4, [mobile]: space.s3 },
		backgroundColor: colors.band,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		textAlign: "start",
	},
	duration: { color: colors.muted, fontVariantNumeric: "tabular-nums" },
	// Slow requests (10 s or more) read in the warning colour, with no extra mark.
	durationSlow: { color: colors.warning },
	agent: { fontWeight: 500 },
	// A request opened from a link: the selected-row tint the other record lists use.
	rowCurrent: { backgroundColor: colors.actionTint },
	// The hidden-rows note sits at the footer's end, apart from the count.
	hidden: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s2,
		marginInlineStart: "auto",
	},
	textButton: {
		minHeight: { default: 24, "@media (pointer: coarse)": 44 },
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: colors.action,
		fontFamily: geometry.fontSans,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		textDecoration: {
			default: "none",
			":hover": "underline",
			":focus-visible": "underline",
		},
		textUnderlineOffset: 3,
		cursor: "pointer",
		outline: "none",
	},
	colTime: { width: 104 },
	colOutcome: { width: 168 },
	colDuration: { width: 104 },
	// A 40px footer row inside the card, under the last request.
	footnote: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		columnGap: space.s3,
		margin: 0,
		minHeight: 40,
		paddingInline: { default: space.s4, [mobile]: space.s3 },
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: colors.line,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontVariantNumeric: "tabular-nums",
	},
	// Single-line rows: 40px tall, outer columns 16px from the frame.
	cell: {
		height: 40,
		paddingBlock: 0,
		paddingInline: space.s3,
		":first-child": { paddingInlineStart: space.s4 },
		":last-child": { paddingInlineEnd: space.s4 },
	},
	stats: {
		display: "grid",
		gridTemplateColumns: {
			default: "repeat(4, minmax(0, 1fr))",
			[mobile]: "repeat(2, minmax(0, 1fr))",
		},
		rowGap: space.s3,
		margin: 0,
		// Its own card, the table's width and inset, so the first stat lines up with the
		// table's first column.
		paddingBlock: 14,
		backgroundColor: colors.surface,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
	},
	stat: {
		display: "grid",
		gap: space.s1,
		minWidth: 0,
		paddingInline: space.s4,
		borderInlineStartWidth: 1,
		borderInlineStartStyle: "solid",
		borderInlineStartColor: {
			default: colors.line,
			":first-child": "transparent",
		},
	},
	statLabel: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	},
	statValue: {
		margin: 0,
		color: colors.text,
		fontSize: 24,
		lineHeight: "30px",
		letterSpacing: "-0.01em",
		fontWeight: 600,
		fontVariantNumeric: "tabular-nums",
	},
	truncate: {
		display: "block",
		maxWidth: 360,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	muted: { color: colors.muted },
	detail: { color: colors.muted },
	code: {
		fontFamily: geometry.fontMono,
		fontSize: 13,
		lineHeight: "20px",
		color: colors.text,
	},
	message: {
		margin: 0,
		padding: `${space.s6} ${space.s4}`,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		textAlign: "center",
	},
	pagination: {
		paddingInline: { default: space.s4, [mobile]: space.s3 },
		paddingBottom: space.s2,
	},
});
