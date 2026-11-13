import {
	ArrowLeftIcon,
	CaretRightIcon,
	CheckIcon,
	MagnifyingGlassIcon,
	UserCheckIcon,
	WarningIcon,
	XIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import {
	APPROVAL_PAGE_SIZE,
	type ApprovalDetail,
	type ApprovalList,
	type ApprovalListInput,
	type ApprovalStatus,
} from "@toolstile/api/approval-contract";
import type { ApprovalClient } from "@toolstile/api/client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AgentMark } from "./AgentMark";
import { formatApprovalParameters } from "./approval-parameters";
import { ConnectionMark } from "./ConnectionMark";
import { controls } from "./Control.styles";
import { formatExpiry, formatFullDate, formatRelative } from "./format";
import { layout } from "./Layout.styles";
import { Pagination } from "./Primitives";
import { useLoaded, useScopedState } from "./ScopedState";
import { StatusBadge, type StatusTone } from "./StatusBadge";
import { useToastFeedback } from "./Toast";
import {
	colors,
	elevation,
	geometry,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

type ApprovalFilter = NonNullable<ApprovalListInput["status"]>;
/** The MCP connections the host knows, so rows can show each connection's logo. */
export type ApprovalConnection = {
	id: string;
	url: string;
	logoUrl?: string | null;
};
/** Approvals page view from validated URL search parameters; parameters never enter the URL. */
export interface ApprovalView {
	status?: ApprovalFilter;
	query?: string;
	page?: number;
	approvalId?: string;
}
type Api = Pick<
	ApprovalClient,
	"listApprovals" | "approvalDetail" | "decideApproval"
>;

const filters: { id: ApprovalFilter; label: string }[] = [
	{ id: "pending", label: "Pending" },
	{ id: "approved", label: "Approved" },
	{ id: "history", label: "History" },
	{ id: "all", label: "All" },
];
const statuses: Record<
	ApprovalStatus,
	{ label: string; tone: StatusTone; detail: string }
> = {
	pending: {
		label: "Pending",
		tone: "warning",
		detail:
			"The agent was told this call needs approval. Approving lets it retry the identical call once.",
	},
	approved: {
		label: "Approved",
		tone: "good",
		detail:
			"Approved for one retry of these exact parameters. Nothing runs until the agent retries.",
	},
	claimed: {
		label: "Running",
		tone: "action",
		detail:
			"The agent claimed this approval for a retry. It may still be waiting to send the call.",
	},
	consumed: {
		label: "Used",
		tone: "neutral",
		detail:
			"This approval was spent on a dispatch attempt and cannot be used again. Check activity for the outcome; a network failure can leave the remote result unknown.",
	},
	denied: {
		label: "Denied",
		tone: "neutral",
		detail: "Denied. The agent cannot run this call with this request.",
	},
	expired: {
		label: "Expired",
		tone: "neutral",
		detail: "Expired before it was used. The agent must ask again.",
	},
	invalidated: {
		label: "Invalidated",
		tone: "neutral",
		detail:
			"No longer valid because the agent's access or the MCP connection changed.",
	},
};
const emptyText: Record<ApprovalFilter, string> = {
	pending:
		"No calls are waiting. A call appears here when an agent uses a tool set to Require approval.",
	approved: "No approved calls are waiting for their retry.",
	history: "No decided, used or expired requests yet.",
	all: "No approval requests yet.",
};
// Common opt-out markers keep review content out of analytics or session-replay tools an embedding host may add.
const privateAttributes = {
	"data-private": "",
	"data-sensitive": "",
	"data-replay-block": "",
	"data-ph-no-capture": "",
} as const;
const privateClass = (className?: string) =>
	[className, "ph-no-capture", "rr-block"].filter(Boolean).join(" ");
/** Context the host may add: the requesting user, the selected upstream account and its origin. */
type RequestContext = {
	requesterLabel?: string | null;
	accountLabel?: string | null;
	destination?: string | null;
};
const context = (request: object) => request as RequestContext;
/** Only the origin of a destination is shown; paths and queries may carry data. */
function destinationOrigin(value?: string | null) {
	if (!value) return undefined;
	try {
		const { origin } = new URL(value);
		return origin === "null" ? undefined : origin;
	} catch {
		return undefined;
	}
}
const lowerFirst = (value: string) =>
	value.charAt(0).toLocaleLowerCase() + value.slice(1);
const expired = (request: { status: ApprovalStatus; expiresAt: string }) =>
	request.status === "pending" && Date.parse(request.expiresAt) <= Date.now();

/**
 * Per-call approval inbox. The filter, search, page and selected request live in the URL;
 * the selected request opens as an inline review beside the list, never as a dialog.
 * `scopeKey` identifies the current authenticated view so stale results never cross it.
 */
export function ApprovalPanel({
	api,
	view,
	onViewChange,
	renderLink,
	scopeKey,
	connections = [],
}: {
	api: Api;
	view: ApprovalView;
	connections?: ApprovalConnection[];
	/** `replace` is set while typing a search so each keystroke does not add history. */
	onViewChange(view: ApprovalView, replace?: boolean): void;
	/** Router link to this page with another view. */
	renderLink(link: {
		view: ApprovalView;
		className: string;
		children: ReactNode;
		"aria-current"?: "page";
		"aria-label"?: string;
	}): ReactNode;
	scopeKey: string;
}) {
	const status = view.status ?? "pending";
	const page = view.page ?? 1;
	const query = view.query ?? "";
	const listView: ApprovalView = {
		status: view.status,
		query: view.query,
		page: view.page,
	};
	const [revision, setRevision] = useScopedState(scopeKey, 0);
	const listKey = JSON.stringify([status, query.trim(), page, revision]);
	const { current } = useLoaded<ApprovalList>({
		scope: scopeKey,
		key: listKey,
		load: () => {
			const trimmed = query.trim();
			return api.listApprovals({
				status,
				...(trimmed ? { query: trimmed } : {}),
				...(page > 1 ? { page: Math.min(page, 1000) } : {}),
			});
		},
		failure: (error) =>
			error instanceof Error
				? error.message
				: "Approval requests could not be loaded.",
	});
	const requests = current?.data?.requests ?? [];
	const selected = view.approvalId;
	// The waiting tally on the Pending tab, whichever filter is open.
	const pendingCount = useLoaded<number>({
		scope: scopeKey,
		key: `pending:${revision}`,
		load: () =>
			api.listApprovals({ status: "pending" }).then((list) => list.total),
		failure: () => "",
	}).current?.data;
	const tabs: { id: ApprovalFilter; label: string; count?: number }[] =
		filters.map((filter) =>
			filter.id === "pending" ? { ...filter, count: pendingCount } : filter,
		);
	const marks = new Map(connections.map((c) => [c.id, c]));
	return (
		<div {...stylex.props(styles.layout, !!selected && styles.layoutReviewing)}>
			<div
				{...stylex.props(
					styles.listColumn,
					!!selected && styles.listWhileReviewing,
				)}
			>
				<section aria-label="Approval requests" {...stylex.props(styles.panel)}>
					<div {...stylex.props(styles.toolbar)}>
						{/* A segmented filter: every status is a slice of the same request list. */}
						<nav aria-label="Approval status" {...stylex.props(styles.filters)}>
							{tabs.map((item) => {
								const isCurrent = item.id === status;
								return (
									<button
										key={item.id}
										type="button"
										aria-current={isCurrent ? "page" : undefined}
										{...stylex.props(
											styles.segment,
											isCurrent && styles.segmentSelected,
										)}
										onClick={() =>
											onViewChange({
												status: item.id === "pending" ? undefined : item.id,
												query: view.query,
											})
										}
									>
										{item.label}
										{item.count ? (
											<span
												{...stylex.props(
													styles.segmentCount,
													isCurrent && styles.segmentCountSelected,
												)}
											>
												{item.count.toLocaleString()}
											</span>
										) : null}
									</button>
								);
							})}
						</nav>
						<label {...stylex.props(styles.search)}>
							<span {...stylex.props(layout.visuallyHidden)}>
								Search by tool, agent or MCP connection
							</span>
							<MagnifyingGlassIcon
								size={16}
								aria-hidden="true"
								{...stylex.props(styles.searchIcon)}
							/>
							<input
								type="search"
								value={query}
								maxLength={100}
								placeholder="Search tool, agent or MCP"
								{...stylex.props(controls.input, styles.searchInput)}
								onChange={(event) =>
									onViewChange(
										{
											status: view.status,
											query: event.target.value || undefined,
											approvalId: view.approvalId,
										},
										true,
									)
								}
							/>
						</label>
					</div>
					{current?.error ? (
						<div role="alert" {...stylex.props(styles.listMessage)}>
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
						<p role="status" {...stylex.props(styles.listMessage, layout.meta)}>
							Loading approval requests…
						</p>
					) : requests.length ? (
						<ul {...stylex.props(styles.list)}>
							{requests.map((request) => {
								const isSelected = request.id === selected;
								const state = expired(request)
									? statuses.expired
									: statuses[request.status];
								const connection = marks.get(request.connectionId);
								// Inside the Pending tab every row is pending; the age says enough.
								const showState =
									status !== "pending" || state !== statuses.pending;
								return (
									<li key={request.id} {...stylex.props(styles.item)}>
										{renderLink({
											view: { ...listView, approvalId: request.id },
											"aria-current": isSelected ? "page" : undefined,
											className:
												stylex.props(
													styles.row,
													isSelected && styles.rowSelected,
												).className ?? "",
											children: (
												<>
													<ConnectionMark
														label={request.connectionLabel}
														url={connection?.url ?? ""}
														logoUrl={connection?.logoUrl}
														size={32}
													/>
													<span {...stylex.props(styles.rowMain)}>
														<code {...stylex.props(styles.rowTool)}>
															{request.tool}
														</code>
														<span {...stylex.props(styles.rowMeta)}>
															<AgentMark label={request.agentLabel} size={16} />
															<span {...stylex.props(styles.rowMetaText)}>
																{[
																	request.agentLabel,
																	request.connectionLabel,
																	context(request).accountLabel,
																]
																	.filter(Boolean)
																	.join(" · ")}
															</span>
														</span>
													</span>
													{showState ? (
														<StatusBadge
															status={state.label}
															tone={state.tone}
														/>
													) : null}
													{/* One quiet time column: when it was asked, and for pending requests when it
													    lapses. Under two hours left is worth noticing, so it becomes a status. */}
													<span {...stylex.props(styles.rowWhen)}>
														<span title={formatFullDate(request.createdAt)}>
															{formatRelative(request.createdAt, Date.now(), {
																compact: true,
															})}
														</span>
														{request.status === "pending" &&
														!expired(request) ? (
															<>
																<span aria-hidden="true">·</span>
																{Date.parse(request.expiresAt) - Date.now() <
																7_200_000 ? (
																	<span
																		title={formatFullDate(request.expiresAt)}
																	>
																		<StatusBadge
																			status={lowerFirst(
																				formatExpiry(request.expiresAt),
																			)}
																			tone="warning"
																		/>
																	</span>
																) : (
																	<span
																		title={formatFullDate(request.expiresAt)}
																	>
																		{lowerFirst(
																			formatExpiry(request.expiresAt),
																		)}
																	</span>
																)}
															</>
														) : null}
													</span>
													<span
														aria-hidden="true"
														{...stylex.props(
															controls.button,
															controls.small,
															styles.rowReview,
															!!selected && styles.rowReviewCompact,
															isSelected && styles.rowReviewSelected,
														)}
													>
														{selected ? null : (
															<span {...stylex.props(styles.rowReviewLabel)}>
																{request.status === "pending" &&
																!expired(request)
																	? "Review"
																	: "View"}
															</span>
														)}
														<CaretRightIcon size={14} />
													</span>
												</>
											),
										})}
									</li>
								);
							})}
						</ul>
					) : (
						<p {...stylex.props(styles.listMessage, styles.emptyMessage)}>
							<UserCheckIcon
								size={20}
								aria-hidden="true"
								{...stylex.props(styles.emptyIcon)}
							/>
							{query.trim()
								? `No requests match “${query.trim()}”.`
								: emptyText[status]}
						</p>
					)}
					{current?.data ? (
						<div {...stylex.props(styles.pagination)}>
							<Pagination
								page={page}
								total={current.data.total}
								size={APPROVAL_PAGE_SIZE}
								onChange={(next) =>
									onViewChange({
										...listView,
										page: next > 1 ? next : undefined,
									})
								}
							/>
						</div>
					) : null}
				</section>
			</div>
			{selected ? (
				<ApprovalReview
					key={`${scopeKey}:${selected}`}
					api={api}
					id={selected}
					scopeKey={scopeKey}
					back={renderLink({
						view: listView,
						className:
							stylex.props(
								controls.button,
								controls.small,
								controls.quiet,
								styles.back,
							).className ?? "",
						"aria-label": "Close review and show all requests",
						children: (
							<>
								<ArrowLeftIcon aria-hidden="true" />
								<span {...stylex.props(styles.backLabel)}>Requests</span>
							</>
						),
					})}
					onDecided={() => setRevision((value) => value + 1)}
				/>
			) : null}
		</div>
	);
}

/** Inline review of one request: identities, expiry and the exact parameters. */
function ApprovalReview({
	api,
	id,
	scopeKey,
	back,
	onDecided,
}: {
	api: Api;
	id: string;
	scopeKey: string;
	back: ReactNode;
	onDecided(): void;
}) {
	const scope = `${scopeKey}:${id}`;
	const notify = useToastFeedback(scope);
	const [revision, setRevision] = useScopedState(scope, 0);
	const [deciding, setDeciding] = useScopedState<"approve" | "deny" | null>(
		scope,
		null,
	);
	const [failure, setFailure] = useScopedState(scope, "");
	const headingRef = useRef<HTMLHeadingElement>(null);
	// A synchronous guard so a double click cannot send a second decision.
	const submitting = useRef(false);
	const { current: fresh, latest: detail } = useLoaded<ApprovalDetail>({
		scope,
		key: String(revision),
		load: () => api.approvalDetail({ id }),
		failure: (error) =>
			error instanceof Error
				? error.message
				: "This request could not be loaded.",
	});
	// Expiry is rechecked each minute so the buttons do not outlive the request.
	const [, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((value) => value + 1), 30_000);
		return () => clearInterval(timer);
	}, []);
	const request = (fresh ?? detail)?.data;
	async function decide(decision: "approve" | "deny") {
		if (submitting.current || !request) return;
		submitting.current = true;
		setDeciding(decision);
		setFailure("");
		try {
			const result = await api.decideApproval({ id, decision });
			if (!result.ok) {
				setFailure(
					"This request can no longer be decided. Its current state is shown below.",
				);
			} else
				notify(
					decision === "approve"
						? `Approved ${request.tool} once. The agent can retry the identical call.`
						: `Denied ${request.tool}.`,
				);
		} catch (error) {
			setFailure(
				error instanceof Error ? error.message : "The decision was not saved.",
			);
		} finally {
			submitting.current = false;
			setDeciding(null);
			setRevision((value) => value + 1);
			onDecided();
			headingRef.current?.focus({ preventScroll: true });
		}
	}
	const state = request
		? expired(request)
			? statuses.expired
			: statuses[request.status]
		: null;
	const parameterDisplay = request?.parameters
		? formatApprovalParameters(request.parameters)
		: { text: "", hasHiddenCharacters: false };
	const decidable =
		!!request &&
		!!fresh?.data &&
		request.status === "pending" &&
		request.canDecide &&
		!expired(request);
	return (
		<section
			aria-labelledby={`approval-${id}-title`}
			{...privateAttributes}
			className={privateClass(
				stylex.props(styles.panel, styles.review).className,
			)}
		>
			<header {...stylex.props(styles.reviewHeader)}>
				{back}
				<h2
					ref={headingRef}
					tabIndex={-1}
					id={`approval-${id}-title`}
					{...stylex.props(styles.reviewTitle)}
				>
					{request ? (
						<code {...stylex.props(styles.reviewTool)}>{request.tool}</code>
					) : (
						"Approval request"
					)}
				</h2>
				{state ? <StatusBadge status={state.label} tone={state.tone} /> : null}
			</header>
			{!request && detail?.error ? (
				<div role="alert" {...stylex.props(styles.reviewBody)}>
					<p {...stylex.props(styles.errorText)}>
						This request is unavailable or you no longer have access.{" "}
						{detail.error}
					</p>
				</div>
			) : !request ? (
				<p role="status" {...stylex.props(styles.reviewBody, layout.meta)}>
					Loading request…
				</p>
			) : (
				<div {...stylex.props(styles.reviewBody)}>
					<p {...stylex.props(layout.muted)}>{state?.detail}</p>
					<dl {...stylex.props(styles.facts)}>
						{context(request).requesterLabel ? (
							<Fact label="Requested by">
								{context(request).requesterLabel}
							</Fact>
						) : null}
						<Fact label="Agent">{request.agentLabel}</Fact>
						<Fact label="MCP connection">{request.connectionLabel}</Fact>
						{context(request).accountLabel ? (
							<Fact label="Account used">{context(request).accountLabel}</Fact>
						) : null}
						{destinationOrigin(context(request).destination) ? (
							<Fact label="Destination">
								{destinationOrigin(context(request).destination)}
							</Fact>
						) : null}
						<Fact label="Requested">
							<Time value={request.createdAt} />
						</Fact>
						{request.status === "pending" || request.status === "approved" ? (
							<Fact label="Expires">
								<Time value={request.expiresAt} />
							</Fact>
						) : null}
						{request.decidedAt ? (
							<Fact label="Decided">
								<Time value={request.decidedAt} />
								{request.decidedBy ? ` by ${request.decidedBy}` : ""}
							</Fact>
						) : null}
					</dl>
					<div {...stylex.props(styles.parameters)}>
						<h3 {...stylex.props(styles.subheading)}>Parameters</h3>
						{parameterDisplay.hasHiddenCharacters ? (
							<p
								id={`approval-${id}-unicode-warning`}
								role="note"
								{...stylex.props(styles.unicodeWarning)}
							>
								<WarningIcon
									size={16}
									aria-hidden="true"
									{...stylex.props(styles.unicodeWarningIcon)}
								/>
								<span>
									Some parameters contain hidden or direction-changing
									characters. They are shown as Unicode escapes below. Check
									these values before approving.
								</span>
							</p>
						) : null}
						{request.parameters ? (
							// A read-only text area escapes the JSON, scrolls and is keyboard focusable.
							<textarea
								readOnly
								spellCheck={false}
								aria-label={`Exact parameters for ${request.tool}`}
								aria-describedby={
									parameterDisplay.hasHiddenCharacters
										? `approval-${id}-unicode-warning`
										: undefined
								}
								rows={Math.min(
									16,
									Math.max(3, parameterDisplay.text.split("\n").length),
								)}
								value={parameterDisplay.text}
								{...privateAttributes}
								className={privateClass(
									stylex.props(controls.textarea, styles.code).className,
								)}
							/>
						) : (
							<p {...stylex.props(layout.muted)}>
								{request.status === "pending" && !request.canDecide
									? "Only people who can decide this request see its parameters."
									: "The parameters for this request are no longer retained."}
							</p>
						)}
					</div>
					{failure ? (
						<p role="alert" {...stylex.props(styles.errorText)}>
							{failure}
						</p>
					) : null}
					{request.status === "pending" && !expired(request) ? (
						request.canDecide ? (
							<div {...stylex.props(styles.decision)}>
								<p {...stylex.props(layout.meta, styles.decisionNote)}>
									Approval covers one retry of exactly these parameters by this
									agent. It does not run the call.
								</p>
								<div {...stylex.props(layout.actions)}>
									<button
										type="button"
										disabled={!decidable || !!deciding}
										{...stylex.props(controls.button, controls.quiet)}
										onClick={() => void decide("deny")}
									>
										<XIcon aria-hidden="true" />
										{deciding === "deny" ? "Denying…" : "Deny"}
									</button>
									<button
										type="button"
										disabled={!decidable || !!deciding}
										{...stylex.props(controls.button, controls.primary)}
										onClick={() => void decide("approve")}
									>
										<CheckIcon aria-hidden="true" />
										{deciding === "approve" ? "Approving…" : "Approve once"}
									</button>
								</div>
							</div>
						) : (
							<p {...stylex.props(layout.meta, styles.decision)}>
								<UserCheckIcon
									size={16}
									aria-hidden="true"
									{...stylex.props(styles.inlineIcon)}
								/>
								You can view this request, but only an authorized reviewer can
								decide it.
							</p>
						)
					) : null}
				</div>
			)}
		</section>
	);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div {...stylex.props(styles.fact)}>
			<dt {...stylex.props(styles.factLabel)}>{label}</dt>
			<dd {...stylex.props(styles.factValue)}>{children}</dd>
		</div>
	);
}

function Time({ value }: { value: string }) {
	return (
		<time dateTime={value} title={formatFullDate(value)}>
			{formatRelative(value)}
		</time>
	);
}

const mobile = "@media (max-width: 760px)";
const wide = "@media (min-width: 1100px)";
// The list panel narrows beside the review, so its filter row follows the panel's width.
const narrowList = "@container (max-width: 599px)";

const styles = stylex.create({
	layout: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr)",
		gap: space.s4,
		alignItems: "start",
		fontFamily: geometry.fontSans,
	},
	// List beside the review on wide screens; on phones the review replaces the list.
	layoutReviewing: {
		gridTemplateColumns: {
			default: "minmax(0, 1fr)",
			[wide]: "minmax(0, 2fr) minmax(0, 3fr)",
		},
	},
	listColumn: { display: "grid", gap: space.s2, minWidth: 0 },
	listWhileReviewing: { display: { default: "grid", [mobile]: "none" } },
	panel: {
		minWidth: 0,
		containerType: "inline-size",
		backgroundColor: colors.surface,
		color: colors.text,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
	},
	toolbar: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		justifyContent: "space-between",
		gap: space.s3,
		minHeight: 48,
		paddingBlock: space.s2,
		paddingInline: { default: space.s4, [mobile]: space.s3 },
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	// The compact segmented control Activity uses for its outcome filter.
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
		fontWeight: 500,
		whiteSpace: "nowrap",
		cursor: "pointer",
		outline: "none",
	},
	segmentSelected: {
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
		flex: { default: "0 1 260px", [narrowList]: "1 1 100%" },
		order: { default: 0, [narrowList]: -1 },
		minWidth: 0,
		alignSelf: "center",
		marginBlock: 0,
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
		height: size.control,
		minHeight: size.control,
		paddingBlock: 0,
	},
	// Rows run edge to edge with a hairline between them, like the other record lists.
	list: { listStyle: "none", margin: 0, padding: 0 },
	item: {
		borderBottomWidth: { default: 1, ":last-child": 0 },
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
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
	rowMain: { display: "grid", gap: space.s0_5, flex: 1, minWidth: 0 },
	rowTool: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		// Mono at 13px reads as heavy as the 14px sans titles elsewhere, not heavier.
		fontFamily: geometry.fontMono,
		fontSize: 13,
		lineHeight: "20px",
	},
	rowMeta: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minWidth: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	rowMetaText: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	// A secondary "Review ›" button; the whole row is the link, so it is drawn, not focusable.
	rowReview: {
		gap: space.s1,
		flexShrink: 0,
		height: 28,
		minHeight: 28,
		paddingInlineStart: space.s3,
		paddingInlineEnd: space.s2,
		fontWeight: 500,
		pointerEvents: "none",
	},
	rowReviewCompact: {
		paddingInline: 0,
		width: size.controlSm,
		justifyContent: "center",
	},
	rowReviewSelected: {
		outline: `2px solid ${colors.focusRing}`,
		outlineOffset: 1,
	},
	rowReviewLabel: { display: { default: "inline", [mobile]: "none" } },
	emptyMessage: {
		flexDirection: "column",
		justifyContent: "center",
		minHeight: 160,
		textAlign: "center",
		color: colors.muted,
	},
	emptyIcon: { color: colors.muted },
	// "3m ago · expires tomorrow": one muted, fixed-width meta column.
	rowWhen: {
		display: { default: "inline-flex", [mobile]: "none" },
		alignItems: "center",
		justifyContent: "flex-end",
		gap: 6,
		flexShrink: 0,
		minWidth: 200,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap",
	},
	listMessage: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: space.s3,
		margin: 0,
		padding: { default: space.s4, [mobile]: space.s3 },
	},
	pagination: {
		paddingInline: { default: space.s4, [mobile]: space.s3 },
		paddingBottom: space.s2,
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
	reviewTool: { fontFamily: geometry.fontMono },
	reviewBody: {
		display: "grid",
		gap: space.s3,
		padding: space.s3,
		minWidth: 0,
	},
	facts: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 180px), 1fr))",
		gap: `${space.s2} ${space.s4}`,
		margin: 0,
	},
	fact: { display: "grid", gap: space.s0_5, minWidth: 0 },
	factLabel: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	factValue: {
		margin: 0,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		overflowWrap: "anywhere",
	},
	parameters: { display: "grid", gap: space.s2, minWidth: 0 },
	// The flat warning strip of `Notice tone="warning"`; a paragraph so it keeps its id.
	unicodeWarning: {
		display: "flex",
		alignItems: "flex-start",
		gap: space.s2,
		margin: 0,
		padding: `${space.s2} ${space.s3}`,
		borderRadius: geometry.corner,
		backgroundColor: colors.warningTint,
		color: colors.text,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	unicodeWarningIcon: {
		flexShrink: 0,
		width: size.icon,
		height: size.icon,
		marginTop: 1,
		color: colors.warning,
	},
	subheading: {
		margin: 0,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 500,
	},
	code: {
		boxSizing: "border-box",
		width: "100%",
		margin: 0,
		minWidth: 0,
		maxHeight: "min(420px, 50dvh)",
		resize: "vertical",
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
	// Separated by the body's 12px gap; no rule above the actions.
	decision: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		flexWrap: "wrap",
		gap: space.s3,
		margin: 0,
	},
	decisionNote: { flex: "1 1 220px" },
	inlineIcon: { flexShrink: 0, verticalAlign: "-3px", marginInlineEnd: 6 },
	errorText: {
		margin: 0,
		color: colors.bad,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		overflowWrap: "anywhere",
	},
});
