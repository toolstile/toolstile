import { Menu } from "@base-ui/react/menu";
import {
	ArrowsClockwiseIcon,
	CaretDownIcon,
	CaretRightIcon,
	CheckIcon,
	CheckSquareIcon,
	DesktopTowerIcon,
	HandIcon,
	ListChecksIcon,
	MagnifyingGlassIcon,
	MinusIcon,
	PlusIcon,
	ProhibitIcon,
	SignInIcon,
	SquareIcon,
	ToggleLeftIcon,
	ToggleRightIcon,
	UserCheckIcon,
	UsersThreeIcon,
	XIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type {
	AllAgentGrantClient,
	ManagementClient,
} from "@toolstile/api/client";
import { builtInTools } from "@toolstile/api/built-in-tools";
import type { ConnectorStarter } from "@toolstile/api/connectors";
import type {
	AccessSearch,
	Rules,
	Snapshot,
	Verification,
} from "@toolstile/api/contract";
import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { AgentMark } from "./AgentMark";
import {
	type Capability,
	type CapabilityRow,
	capabilityKinds,
	capabilityRows,
	cellState,
	countChanges,
	emptyRules,
	isEmptyRules,
	sameRules,
	setFull,
	toggleCell,
	toggleCells,
} from "./access-rules";
import { Checkbox } from "./Checkbox";
import { ConnectionMark } from "./ConnectionMark";
import { controls } from "./Control.styles";
import { layout } from "./Layout.styles";
import { MarkdownPreview } from "./MarkdownContent";
import { popupClassName, popupStyles } from "./Popup.styles";
import { Notice, RelativeTime, Tabs } from "./Primitives";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { StatusBadge } from "./StatusBadge";
import { defaultAccessConnection, statusTone } from "./status";
import { Tooltip } from "./Tooltip";
import {
	colors,
	elevation,
	geometry,
	motion,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

/** Saves and removes the optional per-owner rule that applies to every agent. */
export type EveryoneAccess = Pick<
	AllAgentGrantClient,
	"saveAllAgentGrant" | "removeAllAgentGrant"
>;
/** A server's live catalog, loaded on demand and kept for the session. */
export type CatalogState =
	| { status: "loading"; data?: Verification }
	| { status: "ready"; data: Verification; checkedAt: string }
	| { status: "error"; message: string; data?: Verification };

/** Loads the reviewed starters for the catalog entry a connection came from or addresses. */
export type StarterLoader = (connection: {
	connectorId?: string | null;
	url: string;
}) => Promise<ConnectorStarter[]>;

type Agent = Snapshot["agents"][number];
type Device = Snapshot["devices"][number];
type Connection = Snapshot["connections"][number];
type Column = { id: string; label: string; agent?: Agent; device?: Device };

// Agent ids are UUIDs, so this never collides with an agent column.
const everyoneColumn = "*everyone";
const kindLabels = {
	tools: { one: "tool", many: "tools", title: "Tools" },
	resources: { one: "resource", many: "resources", title: "Resources" },
	prompts: { one: "prompt", many: "prompts", title: "Prompts" },
} as const;
/** The `full` rule: every tool, resource and prompt on the server, now and later. */
const fullLabel = "Everything, including ones added later";
/** The same rule where space is short and the full label is already on screen. */
const fullShort = "Everything";
const plural = (count: number, one: string, many = `${one}s`) =>
	`${count} ${count === 1 ? one : many}`;
const isTemplate = (name: string) => /\{[^}]*\}/.test(name);
const noRows = (): Record<Capability, string[]> => ({
	tools: [],
	resources: [],
	prompts: [],
});

/** Why a typed name cannot be added as a row, or "" when it can. Expects a trimmed name. */
export function addNameProblem(name: string, kind: Capability) {
	const limit = kind === "resources" ? 256 : 200;
	if (/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(name))
		return "Remove the tab, line break or other control character.";
	if (name.length > limit)
		return `Use ${limit} characters or fewer. This name has ${name.length}.`;
	return "";
}

/** Names added by hand that no rule set mentions and the catalog does not offer: not saved. */
export function unsavedRowNames(
	names: string[],
	kind: Capability,
	sets: Rules[],
	offered?: string[],
) {
	return names.filter(
		(name) =>
			!offered?.includes(name) &&
			!sets.some(
				(rules) =>
					rules.allow[kind].includes(name) ||
					rules.block[kind].includes(name) ||
					(kind === "tools" && approvals(rules).includes(name)),
			),
	);
}

/** A catalog failure in plain words; generic transport errors say what happened instead. */
export function catalogProblem(message: string) {
	const trimmed = message.trim();
	if (
		!trimmed ||
		/^(internal server error|internal_server_error|failed to fetch|fetch failed|network error)\.?$/i.test(
			trimmed,
		)
	)
		return "The server did not answer the request for its list.";
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Tool modes. `requireApproval` is an optional conditional grant for tools only: Block beats
 * Require approval, which beats Allow and “Everything”, in this column and in Everyone.
 * Rules copied by the shared grid helpers keep this column's approval list unchanged.
 */
type ToolMode = "allow" | "approval" | "block" | "default";
type ToolEffect = "allowed" | "approval" | "blocked" | "off";
type ToolCell = {
	effect: ToolEffect;
	/** This column's own entry for the tool, when it has one. */
	own?: Exclude<ToolMode, "default">;
	/** Where an effect without an own entry comes from. */
	inherited?: "all" | "everyone" | "everyone-all";
	/** Everyone blocks or requires approval; an agent column may only make it stricter. */
	everyoneLock?: "block" | "approval";
};
const approvals = (rules?: Rules) => rules?.requireApproval ?? [];
export function toolCell(own: Rules, name: string, everyone?: Rules): ToolCell {
	if (everyone?.block.tools.includes(name))
		return { effect: "blocked", inherited: "everyone", everyoneLock: "block" };
	if (own.block.tools.includes(name))
		return { effect: "blocked", own: "block" };
	if (approvals(own).includes(name))
		return { effect: "approval", own: "approval" };
	if (approvals(everyone).includes(name))
		return {
			effect: "approval",
			inherited: "everyone",
			everyoneLock: "approval",
			...(own.allow.tools.includes(name) ? { own: "allow" as const } : {}),
		};
	if (own.allow.tools.includes(name))
		return { effect: "allowed", own: "allow" };
	if (own.full) return { effect: "allowed", inherited: "all" };
	if (everyone?.full) return { effect: "allowed", inherited: "everyone-all" };
	if (everyone?.allow.tools.includes(name))
		return { effect: "allowed", inherited: "everyone" };
	return { effect: "off" };
}
/** The effect without this column's own entry for the tool. */
function toolDefault(own: Rules, name: string, everyone?: Rules) {
	return toolCell(setToolMode(own, name, "default"), name, everyone);
}
/** Rules with exactly one mode for one tool; other entries and lists stay untouched. */
export function setToolMode(
	own: Rules,
	name: string,
	mode: ToolMode,
	everyone?: Rules,
): Rules {
	if (everyone?.block.tools.includes(name)) return own;
	if (mode === "allow" && approvals(everyone).includes(name)) return own;
	const without = (names: string[]) => names.filter((entry) => entry !== name);
	const requireApproval = without(approvals(own));
	const next: Rules = {
		...own,
		allow: { ...own.allow, tools: without(own.allow.tools) },
		block: { ...own.block, tools: without(own.block.tools) },
	};
	if (mode === "allow") next.allow.tools.push(name);
	if (mode === "block") next.block.tools.push(name);
	if (mode === "approval") requireApproval.push(name);
	// An empty approval list is dropped so unchanged rule sets keep their shape.
	if (requireApproval.length) next.requireApproval = requireApproval;
	else delete next.requireApproval;
	return next;
}
/** What applying a starter did to one rule set's draft, tool by tool. */
export interface StarterResult {
	rules: Rules;
	/** Now allowed without review. */
	allowed: string[];
	/** Now running only per approved call, including tools that already required approval. */
	approval: string[];
	/** Left blocked: a starter never lifts a block. */
	blocked: string[];
	/** Named by the starter but not offered by the server now, so left out. */
	missing: string[];
}
/**
 * Adds a reviewed starter's tools to a draft, keeping existing access. It only adds tools the
 * server offers now, never sets
 * “Everything”, never lifts a block (here or in Everyone) and never turns an approval back into
 * an allow, so it cannot widen access beyond the names it lists. Returns null under full access,
 * where a list of names would not narrow anything.
 */
export function applyStarter(
	own: Rules,
	starter: Pick<ConnectorStarter, "allow" | "requireApproval">,
	offered: readonly string[],
	everyone?: Rules,
): StarterResult | null {
	if (own.full || everyone?.full) return null;
	const live = new Set(offered);
	const result: StarterResult = {
		rules: own,
		allowed: [],
		approval: [],
		blocked: [],
		missing: [],
	};
	const each = (names: readonly string[], mode: "allow" | "approval") => {
		for (const name of names) {
			if (!live.has(name)) {
				result.missing.push(name);
				continue;
			}
			const cell = toolCell(result.rules, name, everyone);
			if (cell.effect === "blocked") result.blocked.push(name);
			else if (mode === "approval" || cell.effect === "approval") {
				if (cell.effect !== "approval")
					result.rules = setToolMode(result.rules, name, "approval", everyone);
				result.approval.push(name);
			} else {
				if (cell.own !== "allow")
					result.rules = setToolMode(result.rules, name, "allow", everyone);
				result.allowed.push(name);
			}
		}
	};
	each(starter.requireApproval ?? [], "approval");
	each(starter.allow, "allow");
	return result;
}
const toolModeLabels: Record<ToolEffect, string> = {
	allowed: "Allowed",
	approval: "Requires approval",
	blocked: "Blocked",
	off: "Not allowed",
};
const toolInheritedLabels = {
	all: "because everything is allowed",
	everyone: "from Everyone",
	"everyone-all": "because everything is allowed for Everyone",
} as const;
function toolStateText(cell: ToolCell) {
	if (cell.everyoneLock === "block") return "Blocked for every agent";
	if (cell.everyoneLock === "approval")
		return "Requires approval from Everyone";
	const base = toolModeLabels[cell.effect];
	return cell.own || !cell.inherited
		? base
		: `${base} ${toolInheritedLabels[cell.inherited]}`;
}
const toolModeIcons = {
	allowed: CheckIcon,
	approval: UserCheckIcon,
	blocked: ProhibitIcon,
	off: MinusIcon,
} as const;
type ToolMenuTarget = {
	column: string;
	label: string;
	name: string;
	everyone: boolean;
};
/** What the upstream server declares about one tool. Not verified, so never acted on. */
type ToolHint = NonNullable<Verification["hints"]>[number];
/** One agent that reaches nothing saved on a connection yet, with its draft's counts. */
type FirstGrantState = {
	/** Tools the catalog lists now. */
	total: number;
	/** Of those, allowed or requiring approval in the draft. */
	allowed: number;
	approval: number;
	/** The draft turns on “Everything”, here or through Everyone. */
	full: boolean;
	/** This agent (or Everyone) has unsaved edits. */
	staged: boolean;
	/** Stages Allow for every tool listed now; saves nothing. */
	allowAll(): void;
	/** The draft holds a change that Save can apply. */
	canSave: boolean;
	/** The page's own Save and Discard, offered where the first button was. */
	save(): void;
	discard(): void;
};

/** Agents that can still connect, grouped under their device. */
function agentGroups(data: Snapshot) {
	return data.devices
		.filter((device) => !device.revoked)
		.map((device) => ({
			device,
			agents: data.agents.filter(
				(agent) => agent.deviceId === device.id && !agent.revoked,
			),
		}))
		.filter((group) => group.agents.length);
}

/**
 * Server-first access editor. The selected server, capability tab and filter live in the URL;
 * edits stay in a local draft until saved, and only changed rule sets are written.
 */
export function AccessManager({
	data,
	api,
	everyone,
	view,
	onViewChange,
	catalogs,
	loadCatalog,
	busy,
	save,
	reload,
	renderLink,
	onDirtyChange,
	onSignIn,
	onConnectAgent,
	connectionAccessSummary,
	loadStarters,
}: {
	data: Snapshot;
	api: ManagementClient;
	/** Reviewed starter selections for the catalog entry behind a connection, if any. */
	loadStarters?: StarterLoader;
	/** Host-provided access summary for a connection; `short` fits the server list. */
	connectionAccessSummary(connectionId: string, short?: boolean): string;
	/** Adds the Everyone column; omitted where all-agent rules do not exist. */
	everyone?: EveryoneAccess;
	view: AccessSearch;
	/** `replace` is set for filter typing so each keystroke does not add history. */
	onViewChange(view: AccessSearch, replace?: boolean): void;
	catalogs: Record<string, CatalogState>;
	/** `automatic` marks a load nobody asked for; a refusal then leaves the status alone. */
	loadCatalog(
		connectionId: string,
		refresh?: boolean,
		automatic?: boolean,
	): void;
	busy: boolean;
	save(work: () => Promise<unknown>, success: string): Promise<boolean>;
	reload(): Promise<void>;
	renderLink(link: {
		server: string;
		search?: AccessSearch;
		className: string;
		children: ReactNode;
		"aria-current"?: "page";
	}): ReactNode;
	onDirtyChange(dirty: boolean): void;
	onSignIn(connectionId: string): void;
	onConnectAgent(): void;
}) {
	// Callers render the empty states; there is always at least one server here.
	const server =
		data.connections.find((connection) => connection.id === view.server) ??
		defaultAccessConnection(data.connections);
	const groups = agentGroups(data);
	// Load the selected server's catalog once; Refresh asks again. A member who may not check
	// tools works from the saved names and whatever was already loaded in this browser.
	const loaded = catalogs[server.id];
	const canCheck = server.canCheckTools !== false;
	useEffect(() => {
		if (!loaded && canCheck) loadCatalog(server.id, false, true);
	}, [server.id, loaded, canCheck, loadCatalog]);
	// Starters are display suggestions; a failed load just offers none.
	const [starters, setStarters] = useState<Record<string, ConnectorStarter[]>>(
		{},
	);
	const startersLoaded = server.id in starters;
	useEffect(() => {
		if (!loadStarters || startersLoaded) return;
		let current = true;
		const id = server.id;
		loadStarters({ connectorId: server.connectorId, url: server.url })
			.catch(() => [])
			.then((list) => {
				if (current) setStarters((previous) => ({ ...previous, [id]: list }));
			});
		return () => {
			current = false;
		};
	}, [loadStarters, startersLoaded, server.id, server.connectorId, server.url]);
	// The open connection reports unsaved edits here too, so its rail line does not keep
	// stating the saved access while a different draft is on screen.
	const [openDirty, setOpenDirty] = useState(false);
	const reportDirty = useCallback(
		(dirty: boolean) => {
			setOpenDirty(dirty);
			onDirtyChange(dirty);
		},
		[onDirtyChange],
	);
	function summary(connection: Connection) {
		const tools = catalogs[connection.id]?.data?.tools.length;
		return [
			connection.id === server.id && openDirty
				? "Unsaved changes"
				: connectionAccessSummary(connection.id, true),
			...(tools === undefined ? [] : [plural(tools, "tool")]),
		].join(" · ");
	}
	return (
		<div {...stylex.props(styles.layout)}>
			<div {...stylex.props(styles.serverPane)}>
				<p
					aria-hidden="true"
					{...stylex.props(styles.paneHeader, styles.serverPaneHeader)}
				>
					MCP connections
				</p>
				<nav aria-label="MCP connections" {...stylex.props(styles.serverList)}>
					{data.connections.map((connection) => {
						const selected = connection.id === server.id;
						return (
							<span key={connection.id}>
								{renderLink({
									server: connection.id,
									search: { ...view, server: connection.id },
									className:
										stylex.props(
											styles.serverItem,
											selected && styles.serverSelected,
										).className ?? "",
									"aria-current": selected ? "page" : undefined,
									children: (
										<>
											<ConnectionMark
												label={connection.label}
												url={connection.url}
												logoUrl={connection.logoUrl}
												size={24}
											/>
											<span {...stylex.props(styles.serverText)}>
												<span {...stylex.props(styles.serverName)}>
													{connection.label}
												</span>
												<span
													title={summary(connection)}
													{...stylex.props(styles.serverSummary)}
												>
													{summary(connection)}
												</span>
											</span>
										</>
									),
								})}
							</span>
						);
					})}
				</nav>
			</div>
			<ServerAccess
				key={server.id}
				server={server}
				data={data}
				api={api}
				everyone={everyone}
				groups={groups}
				view={view}
				onViewChange={onViewChange}
				catalog={catalogs[server.id]}
				loadCatalog={loadCatalog}
				busy={busy}
				save={save}
				reload={reload}
				onDirtyChange={reportDirty}
				onSignIn={onSignIn}
				onConnectAgent={onConnectAgent}
				starters={starters[server.id] ?? []}
			/>
		</div>
	);
}

function ServerAccess({
	server,
	data,
	api,
	everyone,
	groups,
	view,
	onViewChange,
	catalog,
	loadCatalog,
	busy,
	save,
	reload,
	onDirtyChange,
	onSignIn,
	onConnectAgent,
	starters,
}: {
	server: Connection;
	data: Snapshot;
	api: ManagementClient;
	everyone?: EveryoneAccess;
	starters: ConnectorStarter[];
	groups: ReturnType<typeof agentGroups>;
	view: AccessSearch;
	onViewChange(view: AccessSearch, replace?: boolean): void;
	catalog?: CatalogState;
	/** `automatic` marks a load nobody asked for; a refusal then leaves the status alone. */
	loadCatalog(
		connectionId: string,
		refresh?: boolean,
		automatic?: boolean,
	): void;
	busy: boolean;
	save(work: () => Promise<unknown>, success: string): Promise<boolean>;
	reload(): Promise<void>;
	onDirtyChange(dirty: boolean): void;
	onSignIn(connectionId: string): void;
	onConnectAgent(): void;
}) {
	const id = useId();
	const kind: Capability = view.capability ?? "tools";
	const query = view.query ?? "";
	/** Edited rule sets by column; a column matching its saved rules is dropped. */
	const [draft, setDraft] = useState<Record<string, Rules>>({});
	/** Names typed in by hand, shown as rows until the page is left. */
	const [added, setAdded] = useState<Record<Capability, string[]>>(noRows);
	const focusHash = typeof window === "undefined" ? "" : window.location.hash;
	useEffect(() => {
		if (!focusHash.startsWith("#access-agent-")) return;
		const target = document.getElementById(focusHash.slice(1));
		if (target) {
			target.scrollIntoView({ block: "nearest", inline: "nearest" });
			target.focus({ preventScroll: true });
		}
	}, [focusHash]);
	const [addName, setAddName] = useState("");
	// One mode menu serves every tool cell; each cell's trigger passes its column and tool.
	const modeMenu = useMemo(() => Menu.createHandle<ToolMenuTarget>(), []);
	const [rowFeedback, setRowFeedback] = useState("");
	const headingRef = useRef<HTMLHeadingElement>(null);
	const revealName = useRef<string | null>(null);
	const saved = (column: string) =>
		(column === everyoneColumn
			? data.allAgentGrants.find((grant) => grant.connectionId === server.id)
			: data.grants.find(
					(grant) =>
						grant.agentId === column && grant.connectionId === server.id,
				)
		)?.rules ?? emptyRules();
	const current = (column: string) => draft[column] ?? saved(column);
	const columns: Column[] = [
		...(everyone ? [{ id: everyoneColumn, label: "Everyone" }] : []),
		...groups.flatMap(({ device, agents }) =>
			agents.map((agent) => ({
				id: agent.id,
				label: agent.label,
				agent,
				device,
			})),
		),
	];
	// Agent cells inherit from the Everyone column, including its unsaved edits.
	const inheritedFrom = (column: Column, rules = current) =>
		column.agent && everyone ? rules(everyoneColumn) : undefined;
	const changes = Object.entries(draft).reduce(
		(total, [column, rules]) => total + countChanges(saved(column), rules),
		0,
	);
	function edit(column: string, change: (rules: Rules) => Rules) {
		setDraft((previous) => {
			const next = change(previous[column] ?? saved(column));
			const { [column]: _replaced, ...rest } = previous;
			return sameRules(next, saved(column))
				? rest
				: { ...rest, [column]: next };
		});
	}
	const catalogData = catalog?.data;
	const descriptions = useMemo(
		() =>
			new Map(
				(catalogData?.descriptions ?? [])
					.filter((entry) => entry.capability === kind)
					.map((entry) => [entry.name, entry.description]),
			),
		[catalogData, kind],
	);
	/** What the upstream server declares about each tool; shown as a tag, never acted on. */
	const hints = useMemo(
		() =>
			new Map<string, ToolHint>(
				kind === "tools"
					? (catalogData?.hints ?? []).map((hint) => [hint.name, hint])
					: [],
			),
		[catalogData, kind],
	);
	// Saved rule sets first, so rows keep their order while drafts change.
	const sets = [
		...columns.map((column) => saved(column.id)),
		...columns.map((column) => current(column.id)),
	];
	/** Rows typed in that no rule keeps yet; leaving the page would drop them. */
	const unsaved = Object.fromEntries(
		capabilityKinds.map((capability) => [
			capability,
			unsavedRowNames(
				added[capability],
				capability,
				sets,
				catalogData?.[capability],
			),
		]),
	) as Record<Capability, string[]>;
	const unsavedCount = capabilityKinds.reduce(
		(total, capability) => total + unsaved[capability].length,
		0,
	);
	const dirty = changes > 0 || unsavedCount > 0;
	useEffect(() => {
		onDirtyChange(dirty);
		return () => onDirtyChange(false);
	}, [dirty, onDirtyChange]);
	// Reloading or closing the tab can only be confirmed by the browser itself.
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		addEventListener("beforeunload", warn);
		return () => removeEventListener("beforeunload", warn);
	}, [dirty]);
	const rowsFor = (capability: Capability) =>
		capabilityRows(
			capability,
			catalogData
				? {
						names: catalogData[capability],
						descriptions: capability === kind ? descriptions : undefined,
					}
				: undefined,
			sets,
			added[capability],
		);
	const rows = rowsFor(kind);
	const needle = query.trim().toLowerCase();
	const visible = needle
		? rows.filter(
				(row) =>
					row.name.toLowerCase().includes(needle) ||
					row.description?.toLowerCase().includes(needle),
			)
		: rows;
	const names = visible.map((row) => row.name);
	const label = kindLabels[kind];
	const canCheck = server.canCheckTools !== false;
	const loading = catalog?.status === "loading" || (!catalog && canCheck);
	const failed = catalog?.status === "error" ? catalog.message : "";
	/** First load: nothing to show yet, so placeholders keep the layout until it arrives. */
	const catalogPending = loading && !catalogData;
	/**
	 * A live check finished here, so the server answered just now. The connection's stored
	 * "needs attention" status can lag behind that answer until the next snapshot says otherwise.
	 */
	const [answered, setAnswered] = useState(false);
	const lastCatalogStatus = useRef(catalog?.status);
	useEffect(() => {
		if (lastCatalogStatus.current === "loading" && catalog?.status === "ready")
			setAnswered(true);
		else if (catalog?.status === "error") setAnswered(false);
		lastCatalogStatus.current = catalog?.status;
	}, [catalog?.status]);
	const serverStatus =
		answered && server.status.trim().toLowerCase() === "needs attention"
			? "reachable"
			: server.status;
	const addProblem = addNameProblem(addName.trim(), kind);
	/** The last starter applied to the draft, with what it did, until save or discard. */
	const [applied, setApplied] = useState<
		(StarterResult & { column: string; name: string }) | null
	>(null);
	function applyStarterTo(column: Column, starter: ConnectorStarter) {
		const result = applyStarter(
			current(column.id),
			starter,
			catalogData?.tools ?? [],
			inheritedFrom(column),
		);
		if (!result) return;
		edit(column.id, () => result.rules);
		setApplied({ ...result, column: column.id, name: starter.name });
	}
	function discard() {
		setDraft({});
		setAdded(noRows());
		setRowFeedback("");
		setApplied(null);
		headingRef.current?.focus({ preventScroll: true });
	}
	async function saveDraft() {
		const pending = Object.entries(draft).filter(
			([column, rules]) => countChanges(saved(column), rules) > 0,
		);
		const done = await save(async () => {
			try {
				for (const [column, rules] of pending) {
					if (column !== everyoneColumn)
						await api.saveGrant({
							agentId: column,
							connectionId: server.id,
							rules,
						});
					else if (!everyone) continue;
					else if (!isEmptyRules(rules))
						await everyone.saveAllAgentGrant({
							connectionId: server.id,
							rules,
						});
					else if (
						data.allAgentGrants.some(
							(grant) => grant.connectionId === server.id,
						)
					)
						await everyone.removeAllAgentGrant({ connectionId: server.id });
				}
			} catch (error) {
				// Show whatever was saved before the failure; the rest stays in the draft.
				await reload().catch(() => undefined);
				throw error;
			}
		}, `Access saved for ${server.label}`);
		if (done) {
			setDraft({});
			setApplied(null);
			headingRef.current?.focus({ preventScroll: true });
		}
	}
	function addRow(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = addName.trim();
		if (!name || addNameProblem(name, kind)) return;
		setRowFeedback(
			rows.some((row) => row.name === name)
				? `${name} already exists. Row shown below.`
				: `${name} added. Choose its access below, then save.`,
		);
		revealName.current = name;
		if (!rows.some((row) => row.name === name))
			setAdded((previous) => ({
				...previous,
				[kind]: [...previous[kind], name],
			}));
		setAddName("");
		// Show the new row even when a filter would hide it.
		if (needle && !name.toLowerCase().includes(needle))
			onViewChange({ ...view, query: undefined }, true);
	}
	// reveal a requested row only after the filtered row DOM updates.
	useEffect(() => {
		const name = revealName.current;
		if (!name) return;
		const row = Array.from(
			document.querySelectorAll<HTMLElement>("[data-capability-name]"),
		).find((element) => element.dataset.capabilityName === name);
		if (row) {
			row.scrollIntoView({ block: "nearest", inline: "nearest" });
			revealName.current = null;
		}
	}, [visible, rowFeedback]);
	/**
	 * Allows or clears several rows. Tools keep their approval and block exceptions: allowing
	 * skips tools that require approval, and clearing blocks only what would still run.
	 */
	function setRows(
		rules: Rules,
		rowNames: string[],
		checked: boolean,
		everyoneRules?: Rules,
	): Rules {
		if (kind !== "tools")
			return toggleCells(rules, kind, rowNames, checked, everyoneRules);
		return rowNames.reduce((next, name) => {
			const cell = toolCell(next, name, everyoneRules);
			if (checked)
				return cell.effect === "approval"
					? next
					: setToolMode(next, name, "allow", everyoneRules);
			if (cell.effect === "blocked") return next;
			return setToolMode(
				next,
				name,
				toolDefault(next, name, everyoneRules).effect === "off"
					? "default"
					: "block",
				everyoneRules,
			);
		}, rules);
	}
	/** Requires approval for each row that is not blocked. */
	const approveRows = (
		rules: Rules,
		rowNames: string[],
		everyoneRules?: Rules,
	) =>
		rowNames.reduce(
			(next, name) =>
				toolCell(next, name, everyoneRules).effect === "blocked"
					? next
					: setToolMode(next, name, "approval", everyoneRules),
			rules,
		);
	const approvalItem = (
		label: string,
		disabled: boolean,
		onSelect: () => void,
	): RowMenuItem[] =>
		kind === "tools"
			? [{ label, icon: UserCheckIcon, disabled, onSelect }]
			: [];
	function modeOptions(target: ToolMenuTarget) {
		const everyoneRules =
			target.everyone || !everyone ? undefined : current(everyoneColumn);
		const rules = current(target.column);
		const cell = toolCell(rules, target.name, everyoneRules);
		const fallback = toolDefault(rules, target.name, everyoneRules);
		return {
			everyoneRules,
			value: cell.own ?? "default",
			options: [
				{
					value: "allow",
					label: "Allow",
					detail:
						cell.everyoneLock === "approval"
							? "Everyone requires approval"
							: "Runs without review",
					icon: CheckIcon,
					disabled: !!cell.everyoneLock,
				},
				{
					value: "approval",
					label: "Require approval",
					detail: "Each call waits for approval of its exact arguments",
					icon: UserCheckIcon,
					disabled: cell.everyoneLock === "block",
				},
				{
					value: "block",
					label: "Block",
					detail: "Never runs, even when everything is allowed",
					icon: ProhibitIcon,
					disabled: false,
				},
				{
					value: "default",
					label: "Use default",
					detail: toolStateText(fallback),
					icon: MinusIcon,
					disabled: false,
				},
			] satisfies {
				value: ToolMode;
				label: string;
				detail: string;
				icon: typeof CheckIcon;
				disabled: boolean;
			}[],
		};
	}
	function columnMenu(column: Column): RowMenuItem[] {
		const everyoneRules = inheritedFrom(column);
		const shown = plural(names.length, label.one, label.many);
		return [
			{
				label: `Allow all ${shown} shown`,
				icon: CheckSquareIcon,
				disabled: !names.length,
				onSelect: () =>
					edit(column.id, (rules) =>
						setRows(rules, names, true, everyoneRules),
					),
			},
			...approvalItem(
				`Require approval for all ${shown} shown`,
				!names.length,
				() =>
					edit(column.id, (rules) => approveRows(rules, names, everyoneRules)),
			),
			{
				label: `Clear all ${shown} shown`,
				icon: SquareIcon,
				disabled: !names.length,
				onSelect: () =>
					edit(column.id, (rules) =>
						setRows(rules, names, false, everyoneRules),
					),
			},
		];
	}
	function deviceMenu(agents: Agent[]): RowMenuItem[] {
		const each = (change: (rules: Rules, everyoneRules?: Rules) => Rules) => {
			const everyoneRules = everyone ? current(everyoneColumn) : undefined;
			for (const agent of agents)
				edit(agent.id, (rules) => change(rules, everyoneRules));
		};
		return [
			{
				label: `Allow all ${label.many} shown for each agent`,
				icon: CheckSquareIcon,
				disabled: !names.length,
				onSelect: () =>
					each((rules, everyoneRules) =>
						setRows(rules, names, true, everyoneRules),
					),
			},
			...approvalItem(
				`Require approval for all ${label.many} shown for each agent`,
				!names.length,
				() =>
					each((rules, everyoneRules) =>
						approveRows(rules, names, everyoneRules),
					),
			),
			{
				label: `Clear all ${label.many} shown for each agent`,
				icon: SquareIcon,
				disabled: !names.length,
				onSelect: () =>
					each((rules, everyoneRules) =>
						setRows(rules, names, false, everyoneRules),
					),
			},
			{
				label: "Allow everything for each agent",
				icon: ToggleRightIcon,
				disabled: !!everyone && current(everyoneColumn).full,
				onSelect: () => each((rules) => setFull(rules, true)),
			},
			{
				label: "Stop allowing everything for each agent",
				icon: ToggleLeftIcon,
				onSelect: () => each((rules) => setFull(rules, false)),
			},
		];
	}
	function rowMenu(row: CapabilityRow): RowMenuItem[] {
		const agentColumns = columns.filter((column) => column.agent);
		const each = (change: (rules: Rules, everyoneRules?: Rules) => Rules) => {
			for (const column of agentColumns)
				edit(column.id, (rules) => change(rules, inheritedFrom(column)));
		};
		return [
			{
				label: "Allow for every agent listed",
				icon: CheckSquareIcon,
				disabled: !agentColumns.length,
				onSelect: () =>
					each((rules, everyoneRules) =>
						setRows(rules, [row.name], true, everyoneRules),
					),
			},
			...approvalItem(
				"Require approval for every agent listed",
				!agentColumns.length,
				() =>
					each((rules, everyoneRules) =>
						approveRows(rules, [row.name], everyoneRules),
					),
			),
			{
				label: "Clear for every agent listed",
				icon: SquareIcon,
				disabled: !agentColumns.length,
				onSelect: () =>
					each((rules, everyoneRules) =>
						setRows(rules, [row.name], false, everyoneRules),
					),
			},
		];
	}
	// Access is edited one agent (or Everyone) at a time.
	const hashAgent = focusHash.startsWith("#access-agent-")
		? focusHash.slice("#access-agent-".length)
		: undefined;
	const wanted =
		view.agent === "everyone" ? everyoneColumn : (view.agent ?? hashAgent);
	const selected =
		columns.find((column) => column.id === wanted) ??
		columns.find((column) => column.agent) ??
		columns[0] ??
		null;
	const agentParam = (column: Column) =>
		column.agent ? column.id : "everyone";
	/** How many rows of this capability a column reaches, for the side panel. */
	function reach(column: Column) {
		const rules = current(column.id);
		const everyoneRules = inheritedFrom(column);
		const count = rows.filter((row) => {
			if (kind === "tools") {
				const effect = toolCell(rules, row.name, everyoneRules).effect;
				return effect === "allowed" || effect === "approval";
			}
			const state = cellState(rules, kind, row.name, everyoneRules);
			return state.checked && !state.blocked;
		}).length;
		return {
			count,
			full: rules.full || !!everyoneRules?.full,
			changed: column.id in draft,
		};
	}
	/**
	 * The empty state for one agent on this connection: nothing saved reaches it, own or
	 * through Everyone. It counts the whole catalog, never the filtered rows.
	 */
	function firstGrantFor(column: Column): FirstGrantState | null {
		const offered = catalogData?.tools ?? [];
		if (!column.agent || kind !== "tools" || needle || !offered.length)
			return null;
		const savedOwn = saved(column.id);
		const savedEveryone = inheritedFrom(column, saved);
		if (savedOwn.full || savedEveryone?.full) return null;
		const reachesSaved = rows.some((row) => {
			const effect = toolCell(savedOwn, row.name, savedEveryone).effect;
			return effect === "allowed" || effect === "approval";
		});
		if (reachesSaved) return null;
		const rules = current(column.id);
		const everyoneRules = inheritedFrom(column);
		let allowed = 0;
		let approval = 0;
		for (const name of offered) {
			const effect = toolCell(rules, name, everyoneRules).effect;
			if (effect === "allowed") allowed += 1;
			else if (effect === "approval") approval += 1;
		}
		return {
			total: offered.length,
			allowed,
			approval,
			full: rules.full || !!everyoneRules?.full,
			staged: column.id in draft || (!!everyone && everyoneColumn in draft),
			allowAll: () =>
				edit(column.id, (next) =>
					setRows(next, offered, true, inheritedFrom(column)),
				),
			canSave: changes > 0,
			save: () => void saveDraft(),
			discard,
		};
	}
	// Adding a name by hand ends the scrolling list, so it never pins over the rows.
	const addForm = (
		<form onSubmit={addRow} {...stylex.props(styles.addRow)}>
			<label {...stylex.props(styles.addLabel)}>
				<span {...stylex.props(styles.addText)}>
					{kind === "resources"
						? "Add a resource URI or URI template"
						: `Add a ${label.one} by name`}
				</span>
				{/* No maxLength: a long paste is reported below instead of cut silently. */}
				<input
					value={addName}
					placeholder={
						kind === "resources" ? "docs://project/{path}" : "exact_name"
					}
					aria-invalid={addProblem ? true : undefined}
					aria-describedby={`${id}-add-hint`}
					{...stylex.props(controls.input, styles.addInput)}
					onChange={(event) => setAddName(event.target.value)}
				/>
			</label>
			<button
				type="submit"
				{...stylex.props(controls.button)}
				disabled={!addName.trim() || !!addProblem}
			>
				<PlusIcon aria-hidden="true" />
				Add row
			</button>
			<p
				id={`${id}-add-hint`}
				aria-live="polite"
				{...stylex.props(styles.addHint, !!addProblem && styles.addError)}
			>
				{addProblem ||
					`Only needed for ${label.many} that ${server.label} does not list yet.`}
			</p>
		</form>
	);
	// Tabs and filter share one row over the tool list; with an agent selected it heads the
	// middle column, so the filter sits above what it filters, not above the reach rail.
	const toolbar = (
		<div {...stylex.props(styles.toolbar)}>
			<div {...stylex.props(styles.tabs)}>
				<Tabs
					label="Capability type"
					value={kind}
					items={capabilityKinds
						// An empty kind adds nothing to choose; it stays while selected.
						.filter(
							(capability) =>
								catalogPending ||
								capability === kind ||
								rowsFor(capability).length > 0,
						)
						.map((capability) => ({
							id: capability,
							// No count until the catalog arrives, so the tab does not jump from saved names.
							label: catalogPending
								? kindLabels[capability].title
								: `${kindLabels[capability].title} ${rowsFor(capability).length}`,
						}))}
					onChange={(capability) =>
						onViewChange({ ...view, server: server.id, capability })
					}
				/>
			</div>
			<label {...stylex.props(styles.search)}>
				<span {...stylex.props(layout.visuallyHidden)}>
					Filter {label.many}
				</span>
				<MagnifyingGlassIcon
					size={16}
					aria-hidden="true"
					{...stylex.props(styles.searchIcon)}
				/>
				<input
					type="search"
					value={query}
					placeholder={`Filter ${label.many}`}
					maxLength={100}
					{...stylex.props(controls.input, styles.searchInput)}
					onChange={(event) =>
						onViewChange(
							{
								...view,
								server: server.id,
								query: event.target.value || undefined,
							},
							true,
						)
					}
				/>
			</label>
		</div>
	);
	return (
		<section aria-labelledby={`${id}-title`} {...stylex.props(styles.panel)}>
			{/* One line for the server and its health; the tabs carry the capability counts. */}
			<header
				{...stylex.props(
					styles.panelHeader,
					selected && groups.length > 0 && styles.panelHeaderSplit,
				)}
			>
				<div {...stylex.props(styles.panelHeaderMain)}>
					<ConnectionMark
						label={server.label}
						url={server.url}
						logoUrl={server.logoUrl}
						size={24}
					/>
					{/* A breadcrumb: the connection, then the agent being edited, which is the subject. */}
					<h2
						ref={headingRef}
						tabIndex={-1}
						id={`${id}-title`}
						{...stylex.props(styles.panelTitle)}
					>
						<span {...stylex.props(selected && styles.crumbServer)}>
							{server.label}
						</span>
						{selected ? (
							<>
								<span
									aria-hidden="true"
									{...stylex.props(styles.crumbSeparator)}
								>
									/
								</span>
								<span {...stylex.props(styles.crumbAgent)}>
									{selected.agent ? (
										<AgentMark label={selected.label} size={20} />
									) : (
										<span
											aria-hidden="true"
											{...stylex.props(styles.everyoneMark, styles.crumbMark)}
										>
											<UsersThreeIcon size={14} />
										</span>
									)}
									<span {...stylex.props(styles.crumbAgentName)}>
										{selected.agent ? selected.label : "Everyone"}
									</span>
								</span>
							</>
						) : null}
					</h2>
					{selected ? (
						<span {...stylex.props(styles.crumbDevice)}>
							{selected.agent
								? selected.device?.label
								: "All agents, now and later"}
						</span>
					) : null}
					{/* Healthy is the expected state; only a problem earns a status here. */}
					{statusTone(serverStatus) === "good" ? null : (
						<StatusBadge status={serverStatus} />
					)}
					<p {...stylex.props(styles.panelMeta)} aria-live="polite">
						{loading ? (
							<span {...stylex.props(styles.loadingStatus)}>
								<ArrowsClockwiseIcon
									size={14}
									aria-hidden="true"
									{...stylex.props(styles.spinning)}
								/>
								{/* The server's name is the heading beside it, so one short line is enough. */}
								<span {...stylex.props(styles.loadingText)}>
									{catalogData
										? `Refreshing ${label.many}…`
										: `Loading ${label.many}…`}
								</span>
							</span>
						) : failed ? (
							"List not loaded"
						) : null}
					</p>
					{canCheck ? (
						<Tooltip
							label={
								dirty ? (
									"Save or discard your changes to refresh tools"
								) : catalog?.status === "ready" ? (
									<>
										Refresh tools · checked{" "}
										<RelativeTime value={catalog.checkedAt} compact />
									</>
								) : (
									"Refresh tools"
								)
							}
						>
							<button
								type="button"
								aria-label="Refresh tools"
								{...stylex.props(
									controls.button,
									controls.small,
									controls.quiet,
									controls.iconOnly,
									styles.refresh,
								)}
								// Stays in place while edits are unsaved, so the header never changes size.
								disabled={loading || dirty}
								onClick={() => loadCatalog(server.id, true)}
							>
								<ArrowsClockwiseIcon
									size={16}
									aria-hidden="true"
									{...stylex.props(loading && styles.spinning)}
								/>
							</button>
						</Tooltip>
					) : null}
				</div>
				{/* The agent rail's heading shares the header row, so all three panes align. */}
				{selected && groups.length > 0 ? (
					<p
						aria-hidden="true"
						{...stylex.props(styles.paneHeader, styles.reachHeader)}
					>
						{label.title} by agent
					</p>
				) : null}
			</header>
			{failed ? (
				<div {...stylex.props(styles.catalogError)}>
					<Notice tone="error">
						<div {...stylex.props(styles.catalogErrorBody)}>
							<p {...stylex.props(styles.catalogErrorText)}>
								<strong {...stylex.props(styles.strong)}>
									Couldn’t load the list of {label.many} from {server.label}.
								</strong>{" "}
								{catalogProblem(failed)}
								{/try again/i.test(failed) ? "" : " Select Try again."} Until
								the list loads, you can still change saved {label.one} names and
								“{fullShort}”.
							</p>
							<div {...stylex.props(styles.inlineActions)}>
								{server.authentication === "oauth" &&
								server.canManageAuthentication ? (
									<button
										type="button"
										{...stylex.props(controls.button, controls.small)}
										onClick={() => onSignIn(server.id)}
									>
										<SignInIcon aria-hidden="true" />
										Sign in
									</button>
								) : null}
								{canCheck ? (
									<button
										type="button"
										{...stylex.props(controls.button, controls.small)}
										onClick={() => loadCatalog(server.id, true)}
									>
										Try again
									</button>
								) : null}
							</div>
						</div>
					</Notice>
				</div>
			) : null}
			{kind === "resources" &&
			sets.some((rules) =>
				[...rules.allow.resources, ...rules.block.resources].some(isTemplate),
			) ? (
				<p {...stylex.props(styles.note)}>
					A URI template also allows or blocks every resource URI it matches.
					Those matches are enforced but not shown on individual rows.
				</p>
			) : null}
			{!groups.length ? (
				<p {...stylex.props(styles.note)}>
					No agents yet. Everyone access applies to agents you connect later.{" "}
					<button
						type="button"
						{...stylex.props(styles.linkButton)}
						onClick={onConnectAgent}
					>
						Connect an agent
					</button>
				</p>
			) : null}
			{selected ? (
				<AgentAccessView
					key={selected.id}
					server={server}
					kind={kind}
					column={selected}
					groups={groups}
					everyoneShown={!!everyone}
					columns={columns}
					rows={rows}
					visible={visible}
					unsaved={unsaved[kind]}
					blocks={sets.some((rules) => rules.block[kind].length > 0)}
					needle={needle}
					query={query}
					loading={loading}
					catalogPending={catalogPending}
					failed={failed}
					busy={busy}
					rules={current(selected.id)}
					savedRules={saved(selected.id)}
					everyoneRules={inheritedFrom(selected)}
					savedEveryoneRules={inheritedFrom(selected, saved)}
					reach={reach}
					modeMenu={modeMenu}
					columnMenu={columnMenu(selected)}
					rowMenu={rowMenu}
					onSelect={(column) =>
						onViewChange({
							...view,
							server: server.id,
							agent: agentParam(column),
						})
					}
					onEdit={(change) => edit(selected.id, change)}
					deviceMenu={deviceMenu}
					starters={
						kind === "tools" && !catalogPending && !failed ? starters : []
					}
					applied={applied?.column === selected.id ? applied : null}
					onApplyStarter={(starter) => applyStarterTo(selected, starter)}
					addForm={addForm}
					addPending={!!addName}
					hints={hints}
					firstGrant={firstGrantFor(selected)}
					toolbar={toolbar}
				/>
			) : (
				// No agent and no Everyone rule to edit: the names alone, for reference.
				<>
					{toolbar}
					<ul
						aria-label={`${label.title} on ${server.label}`}
						{...stylex.props(styles.checklist)}
					>
						{visible.map((row) => (
							<li key={row.name} {...stylex.props(styles.checkRow)}>
								<CheckText
									row={row}
									kind={kind}
									hint={hints.get(row.name)}
									server={server.label}
								/>
							</li>
						))}
					</ul>
				</>
			)}
			{selected ? null : (
				<div {...stylex.props(styles.addInset)}>{addForm}</div>
			)}
			{rowFeedback && (
				<p role="status" {...stylex.props(styles.panelMeta)}>
					{rowFeedback}
				</p>
			)}
			{/* Pinned to the panel's bottom edge, so it arrives without moving anything above it. */}
			{dirty ? (
				<section
					aria-label="Unsaved access changes"
					{...stylex.props(styles.saveBar)}
				>
					<p aria-live="polite" {...stylex.props(styles.saveText)}>
						{changes
							? `${plural(changes, "change")} not saved`
							: `${plural(unsavedCount, "added row")} not saved`}
					</p>
					<span {...stylex.props(styles.saveActions)}>
						<button
							type="button"
							{...stylex.props(controls.button, controls.small, controls.quiet)}
							disabled={busy}
							onClick={discard}
						>
							Discard
						</button>
						<button
							type="button"
							{...stylex.props(
								controls.button,
								controls.small,
								controls.primary,
							)}
							// An added row is kept by choosing its access; there is nothing else to save.
							disabled={busy || !changes}
							title={
								changes
									? undefined
									: "Choose access for the added row to save it."
							}
							onClick={() => void saveDraft()}
						>
							{busy ? "Saving…" : "Save changes"}
						</button>
					</span>
				</section>
			) : null}
			<Menu.Root handle={modeMenu}>
				{({ payload: target }) => {
					if (!target) return null;
					const { everyoneRules, value, options } = modeOptions(target);
					return (
						<Menu.Portal>
							<Menu.Positioner
								side="bottom"
								align="center"
								sideOffset={4}
								collisionPadding={8}
								{...stylex.props(popupStyles.positioner)}
							>
								<Menu.Popup
									className={popupClassName(popupStyles.menu, styles.modeMenu)}
								>
									<Menu.Group>
										<Menu.GroupLabel {...stylex.props(styles.modeMenuLabel)}>
											<code {...stylex.props(styles.modeMenuName)}>
												{target.name}
											</code>
											for {target.label}
										</Menu.GroupLabel>
										<Menu.RadioGroup
											value={value}
											onValueChange={(next: ToolMode) =>
												edit(target.column, (rules) =>
													setToolMode(rules, target.name, next, everyoneRules),
												)
											}
										>
											{options.map((option) => (
												<Menu.RadioItem
													key={option.value}
													value={option.value}
													label={option.label}
													disabled={option.disabled}
													closeOnClick
													className={(state) =>
														stylex.props(
															popupStyles.item,
															styles.modeItem,
															state.highlighted && popupStyles.highlighted,
															state.disabled && popupStyles.disabled,
														).className
													}
												>
													<option.icon
														size={16}
														aria-hidden="true"
														{...stylex.props(styles.modeItemIcon)}
													/>
													<span {...stylex.props(styles.modeItemText)}>
														{option.label}
														<span {...stylex.props(styles.modeItemDetail)}>
															{option.detail}
														</span>
													</span>
													<Menu.RadioItemIndicator
														{...stylex.props(styles.modeItemCheck)}
													>
														<CheckIcon size={16} aria-hidden="true" />
													</Menu.RadioItemIndicator>
												</Menu.RadioItem>
											))}
										</Menu.RadioGroup>
									</Menu.Group>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					);
				}}
			</Menu.Root>
		</section>
	);
}

/**
 * One agent's access on one server: its tools as a checklist with each tool's mode, and the
 * other agents' reach beside it. Edits go to the same draft as the grid.
 */
function AgentAccessView({
	server,
	kind,
	column,
	columns,
	groups,
	everyoneShown,
	rows,
	visible,
	unsaved,
	blocks,
	needle,
	query,
	loading,
	catalogPending,
	failed,
	busy,
	rules,
	savedRules,
	everyoneRules,
	savedEveryoneRules,
	reach,
	modeMenu,
	columnMenu,
	rowMenu,
	onSelect,
	onEdit,
	deviceMenu,
	starters,
	applied,
	onApplyStarter,
	addForm,
	addPending,
	hints,
	firstGrant,
	toolbar,
}: {
	server: Connection;
	kind: Capability;
	column: Column;
	/** Text is typed into the add-by-name field. */
	addPending: boolean;
	/** Server-declared tool hints by name. */
	hints: Map<string, ToolHint>;
	/** Set while this agent reaches nothing saved on the connection. */
	firstGrant: FirstGrantState | null;
	/** Reviewed starters to offer here; empty where none apply. */
	starters: ConnectorStarter[];
	/** What the last starter applied to this column did. */
	applied: (StarterResult & { name: string }) | null;
	onApplyStarter(starter: ConnectorStarter): void;
	/** The add-by-name form, shown after the list inside the scrolling column. */
	addForm: ReactNode;
	/** Capability tabs and the filter, pinned above the scrolling column. */
	toolbar: ReactNode;
	columns: Column[];
	groups: ReturnType<typeof agentGroups>;
	everyoneShown: boolean;
	rows: CapabilityRow[];
	visible: CapabilityRow[];
	/** Rows typed in that no rule keeps yet. */
	unsaved: string[];
	/** Whether any rule set blocks a row of this kind, so the block note applies. */
	blocks: boolean;
	needle: string;
	query: string;
	loading: boolean;
	catalogPending: boolean;
	failed: string;
	busy: boolean;
	rules: Rules;
	savedRules: Rules;
	everyoneRules?: Rules;
	savedEveryoneRules?: Rules;
	reach(column: Column): { count: number; full: boolean; changed: boolean };
	modeMenu: ReturnType<typeof Menu.createHandle<ToolMenuTarget>>;
	columnMenu: RowMenuItem[];
	rowMenu(row: CapabilityRow): RowMenuItem[];
	onSelect(column: Column): void;
	onEdit(change: (rules: Rules) => Rules): void;
	/** Bulk changes for every agent on one device. */
	deviceMenu(agents: Agent[]): RowMenuItem[];
}) {
	const label = kindLabels[kind];
	const who = column.agent
		? `${column.label} on ${column.device?.label}`
		: "every agent";
	const inheritedFull = !rules.full && !!everyoneRules?.full;
	const fullOn = rules.full || inheritedFull;
	const everyoneColumnEntry = columns.find((entry) => !entry.agent);
	const id = useId();
	// “Everything” and add-by-name are secondary; they open by themselves whenever in use,
	// and stay open by default when the list failed to load and adding by name is the way in.
	const optionsNeeded = fullOn || unsaved.length > 0 || addPending || !!failed;
	const [optionsOpen, setOptionsOpen] = useState(optionsNeeded);
	const optionsWereNeeded = useRef(optionsNeeded);
	useEffect(() => {
		if (optionsNeeded && !optionsWereNeeded.current) setOptionsOpen(true);
		optionsWereNeeded.current = optionsNeeded;
	}, [optionsNeeded]);
	// The last sentence stays true when unset tools inherit something.
	const everyoneGrants =
		!!everyoneRules &&
		(everyoneRules.full ||
			everyoneRules.allow.tools.length > 0 ||
			approvals(everyoneRules).length > 0);
	const unsetText = !column.agent
		? "Unset tools are left to each agent."
		: fullOn
			? "Unset tools are allowed through “Everything”."
			: everyoneGrants
				? "Unset tools follow Everyone."
				: "Unset tools are not allowed.";
	const builtIns =
		kind === "tools"
			? builtInTools.filter(
					(tool) =>
						!needle ||
						tool.name.toLowerCase().includes(needle) ||
						tool.reads.toLowerCase().includes(needle),
				)
			: [];
	const bar = (entry: Column) => {
		const { count, full, changed } = reach(entry);
		const selected = entry.id === column.id;
		return (
			<li key={entry.id}>
				<button
					type="button"
					aria-current={selected ? "true" : undefined}
					onClick={() => onSelect(entry)}
					{...stylex.props(styles.reachItem, selected && styles.reachSelected)}
				>
					<span {...stylex.props(styles.reachHead)}>
						<span {...stylex.props(styles.reachName)}>
							{entry.agent ? <AgentMark label={entry.label} size={18} /> : null}
							<span {...stylex.props(styles.reachNameText)}>
								{entry.agent ? entry.label : "Everyone"}
							</span>
						</span>
						<span {...stylex.props(styles.reachValue)}>
							{catalogPending && !full ? (
								<span
									{...stylex.props(styles.placeholder, styles.placeholderValue)}
								/>
							) : full ? (
								fullShort
							) : count ? (
								`${count} of ${rows.length}`
							) : (
								"None"
							)}
						</span>
					</span>
					<span aria-hidden="true" {...stylex.props(styles.meter)}>
						<span
							{...stylex.props(
								styles.meterFill,
								styles.meterWidth(
									full ? 100 : rows.length ? (count / rows.length) * 100 : 0,
								),
							)}
						/>
					</span>
					{changed ? (
						<span {...stylex.props(styles.reachMeta)}>Unsaved preview</span>
					) : null}
				</button>
			</li>
		);
	};
	return (
		<div {...stylex.props(styles.agentLayout)}>
			<div {...stylex.props(styles.agentColumn)}>
				{toolbar}
				<div {...stylex.props(styles.agentMain)}>
					{loading && !catalogPending ? (
						<span aria-hidden="true" {...stylex.props(styles.refreshBar)} />
					) : null}
					{/* First, so the one action a new agent needs sits above the editor's controls. */}
					{firstGrant && column.agent ? (
						<FirstGrant
							grant={firstGrant}
							server={server.label}
							agent={column.label}
							busy={busy}
						/>
					) : null}
					<div
						id={column.agent ? `access-agent-${column.agent.id}` : undefined}
						tabIndex={-1}
						{...stylex.props(styles.agentHead)}
					>
						{/* The breadcrumb above names the agent; this row holds its bulk controls. */}
						<BulkActions
							items={columnMenu}
							disabled={busy}
							context={column.agent ? column.label : "Everyone"}
							shown={
								needle ? `${visible.length} of ${rows.length} shown` : undefined
							}
						/>
					</div>
					{kind === "tools" ? (
						<p {...stylex.props(styles.modeHelp)}>
							Allow runs without review. Ask waits for your approval.{" "}
							{unsetText}
						</p>
					) : null}
					{(fullOn ? blocks : starters.length > 0) ? (
						// One quiet line under the agent. With “Everything” on, the rule that blocks
						// still win; otherwise the reviewed starters (they only narrow a partial grant).
						<div {...stylex.props(styles.hintRow)}>
							{!fullOn ? (
								<StarterStrip
									starters={starters}
									applied={applied}
									who={who}
									full={false}
									busy={busy}
									onApply={onApplyStarter}
								/>
							) : (
								<p {...stylex.props(styles.fullNote)}>
									<ProhibitIcon size={12} aria-hidden="true" />A blocked{" "}
									{label.one} stays blocked, even under “Everything”.
								</p>
							)}
						</div>
					) : null}
					{catalogPending ? (
						<ul aria-hidden="true" {...stylex.props(styles.checklist)}>
							{[64, 48, 72, 56, 40, 60].map((width) => (
								<li key={width} {...stylex.props(styles.checkRow)}>
									<span
										{...stylex.props(styles.placeholder, styles.placeholderBox)}
									/>
									<span {...stylex.props(styles.placeholderText)}>
										<span
											{...stylex.props(
												styles.placeholder,
												styles.placeholderLine,
												styles.placeholderWidth(width / 2),
											)}
										/>
										<span
											{...stylex.props(
												styles.placeholder,
												styles.placeholderLine,
												styles.placeholderWidth(width),
											)}
										/>
									</span>
									<span
										{...stylex.props(
											styles.placeholder,
											styles.placeholderChip,
										)}
									/>
								</li>
							))}
						</ul>
					) : visible.length ? (
						<ul
							aria-label={`${label.title} for ${who}`}
							{...stylex.props(styles.checklist)}
						>
							{visible.map((row) => {
								if (kind === "tools") {
									const cell = toolCell(rules, row.name, everyoneRules);
									const before = toolCell(
										savedRules,
										row.name,
										savedEveryoneRules,
									);
									const pending = unsaved.includes(row.name);
									const changed =
										pending ||
										cell.effect !== before.effect ||
										cell.own !== before.own;
									const Icon = toolModeIcons[cell.effect];
									const state = toolStateText(cell);
									// Under “Everything” an unchanged allowed tool is plain text; the control
									// shows on hover or focus. Exceptions keep their colour and chrome.
									const quietState =
										fullOn &&
										!changed &&
										(cell.effect === "allowed" || cell.effect === "off");
									return (
										<li
											key={row.name}
											data-capability-name={row.name}
											{...stylex.props(
												styles.checkRow,
												changed && styles.checkRowChanged,
												stylex.defaultMarker(),
											)}
										>
											{/* The mode menu states and changes the tool's access; no separate checkbox. */}
											<div
												{...stylex.props(styles.checkLabel, styles.rowNameCell)}
											>
												<CheckText
													row={row}
													kind={kind}
													unsaved={pending}
													hint={hints.get(row.name)}
													server={server.label}
												/>
											</div>
											<IconActions
												items={rowMenu(row)}
												disabled={busy}
												context={row.name}
												reveal
											/>
											<Menu.Trigger
												handle={modeMenu}
												payload={{
													column: column.id,
													label: column.agent ? column.label : "Everyone",
													name: row.name,
													everyone: !column.agent,
												}}
												disabled={busy || cell.everyoneLock === "block"}
												title={`${state}. Choose Allow, Require approval, Block or the default.`}
												aria-label={`${row.name} for ${who}: ${state}`}
												{...stylex.props(
													styles.modeChip,
													styles[`chip_${cell.effect}`],
													!cell.own &&
														cell.effect !== "off" &&
														styles.chipInherited,
													cell.effect === "allowed" && styles.chipQuiet,
													// Under “Everything” the column recedes; only exceptions keep colour.
													quietState && styles.chipMuted,
												)}
											>
												<Icon
													size={12}
													weight="bold"
													aria-hidden="true"
													{...stylex.props(quietState && styles.chipReveal)}
												/>
												{toolModeLabels[cell.effect]}
												<CaretDownIcon
													size={10}
													aria-hidden="true"
													{...stylex.props(quietState && styles.chipReveal)}
												/>
											</Menu.Trigger>
										</li>
									);
								}
								const state = cellState(rules, kind, row.name, everyoneRules);
								const before = cellState(
									savedRules,
									kind,
									row.name,
									savedEveryoneRules,
								);
								const pending = unsaved.includes(row.name);
								const changed =
									pending ||
									before.checked !== state.checked ||
									before.blocked !== state.blocked;
								return (
									<li
										key={row.name}
										data-capability-name={row.name}
										{...stylex.props(
											styles.checkRow,
											changed && styles.checkRowChanged,
											stylex.defaultMarker(),
										)}
									>
										<label
											title={cellTitle(state, column.label)}
											{...stylex.props(styles.checkLabel)}
										>
											<Checkbox
												checked={state.checked}
												disabled={busy || state.blocked === "everyone"}
												inherited={!!state.inherited}
												aria-label={`Allow ${row.name} for ${who}`}
												onCheckedChange={(checked) =>
													onEdit((current) =>
														toggleCell(
															current,
															kind,
															row.name,
															checked,
															everyoneRules,
														),
													)
												}
											/>
											<CheckText row={row} kind={kind} unsaved={pending} />
										</label>
										{state.blocked ? (
											<span
												{...stylex.props(styles.modeChip, styles.chip_blocked)}
											>
												<ProhibitIcon
													size={12}
													weight="bold"
													aria-hidden="true"
												/>
												Blocked
											</span>
										) : state.inherited ? (
											<span
												{...stylex.props(
													styles.modeChip,
													styles.chip_inheritedNote,
												)}
											>
												Inherited
											</span>
										) : null}
										<IconActions
											items={rowMenu(row)}
											disabled={busy}
											context={row.name}
											reveal
										/>
									</li>
								);
							})}
						</ul>
					) : (
						<p {...stylex.props(styles.agentEmpty)}>
							{needle
								? `No ${label.many} match “${query.trim()}”.`
								: failed
									? `No saved ${label.one} names. Add one by name below.`
									: `${server.label} offers no ${label.many}.`}
						</p>
					)}
					<div {...stylex.props(styles.moreOptions)}>
						<button
							type="button"
							aria-expanded={optionsOpen}
							aria-controls={`${id}-more`}
							onClick={() => setOptionsOpen((open) => !open)}
							{...stylex.props(styles.moreToggle)}
						>
							<CaretRightIcon
								size={14}
								aria-hidden="true"
								{...stylex.props(
									styles.moreCaret,
									optionsOpen && styles.moreCaretOpen,
								)}
							/>
							More options
							<span {...stylex.props(styles.moreSummary)}>
								“{fullShort}” and adding a {label.one} by name
							</span>
						</button>
						<div
							id={`${id}-more`}
							hidden={!optionsOpen}
							{...stylex.props(
								styles.moreBody,
								!optionsOpen && styles.collapsed,
							)}
						>
							<label
								title={
									inheritedFull
										? "Included through Everyone"
										: `Allow every tool, resource and prompt on ${server.label} for ${who}, including ones added later`
								}
								{...stylex.props(styles.agentFull)}
							>
								<Checkbox
									checked={rules.full || inheritedFull}
									disabled={busy || inheritedFull}
									inherited={inheritedFull}
									// Starts with the visible text so voice control can still find it.
									aria-label={`${fullLabel}: allow every tool, resource and prompt on ${server.label} for ${who}`}
									onCheckedChange={(full) =>
										onEdit((current) => setFull(current, full))
									}
								/>
								{fullLabel}
							</label>
							{addForm}
						</div>
					</div>
					{builtIns.length ? (
						<section
							aria-labelledby={`${id}-builtin`}
							{...stylex.props(styles.builtIn)}
						>
							<h3 id={`${id}-builtin`} {...stylex.props(styles.builtInBand)}>
								Built into Toolstile
								<span {...stylex.props(styles.builtInCount)}>
									· {builtIns.length}
								</span>
							</h3>
							<p {...stylex.props(styles.builtInNote)}>
								Every connected agent has these. They are read-only and are not
								part of any connection.
							</p>
							<ul {...stylex.props(styles.checklist)}>
								{builtIns.map((tool) => (
									<li key={tool.name} {...stylex.props(styles.checkRow)}>
										<span {...stylex.props(styles.rowText)}>
											<code title={tool.name} {...stylex.props(styles.rowName)}>
												{tool.name}
											</code>
											<span {...stylex.props(styles.builtInReads)}>
												{tool.reads}
											</span>
										</span>
										<span {...stylex.props(styles.builtInState)}>
											Always available
										</span>
									</li>
								))}
							</ul>
						</section>
					) : null}
				</div>
			</div>
			<aside
				aria-label={`${label.title} each agent reaches on ${server.label}`}
				{...stylex.props(styles.reachPanel)}
			>
				<p {...stylex.props(styles.reachTitle)}>{label.title} by agent</p>
				<ul {...stylex.props(styles.reachList)}>
					{everyoneShown && everyoneColumnEntry
						? bar(everyoneColumnEntry)
						: null}
					{groups.map(({ device, agents }) => (
						<li key={device.id} {...stylex.props(styles.reachGroup)}>
							<span {...stylex.props(styles.reachDevice)}>
								<DesktopTowerIcon size={14} aria-hidden="true" />
								<span {...stylex.props(styles.reachDeviceName)}>
									{device.label}
								</span>
								<span {...stylex.props(styles.reachDeviceCount)}>
									· {agents.length}
								</span>
								<RowMenu
									label={`Change access for every agent on ${device.label}`}
									disabled={busy}
									items={deviceMenu(agents)}
									size="small"
								/>
							</span>
							<ul {...stylex.props(styles.reachList)}>
								{agents.map((agent) => {
									const entry = columns.find((item) => item.id === agent.id);
									return entry ? bar(entry) : null;
								})}
							</ul>
						</li>
					))}
				</ul>
			</aside>
		</div>
	);
}

/**
 * A short list of row actions as direct icon buttons with tooltips, instead of an overflow
 * menu. `reveal` keeps them hidden until the row is hovered or one of them has focus (always
 * shown on touch screens), so long lists stay calm.
 */
function IconActions({
	items,
	disabled,
	context,
	reveal = false,
}: {
	items: RowMenuItem[];
	disabled?: boolean;
	/** What the actions apply to, added to each button's accessible name. */
	context: string;
	reveal?: boolean;
}) {
	return (
		<span
			{...stylex.props(styles.iconActions, reveal && styles.iconActionsReveal)}
		>
			{items.map((item) => {
				const ItemIcon = item.icon ?? CheckIcon;
				return (
					<Tooltip key={item.label} label={item.label}>
						<button
							type="button"
							aria-label={`${item.label} (${context})`}
							disabled={disabled || item.disabled}
							onClick={item.onSelect}
							{...stylex.props(
								controls.button,
								controls.quiet,
								controls.small,
								controls.iconOnly,
								styles.iconAction,
							)}
						>
							<ItemIcon size={16} aria-hidden="true" />
						</button>
					</Tooltip>
				);
			})}
		</span>
	);
}

/** Short visible labels for the bulk actions; the accessible name keeps the full sentence. */
/** Action glyphs for the bulk buttons; the menus keep their checkbox-style icons. */
const bulkIcons = new Map<RowMenuItem["icon"], RowMenuItem["icon"]>([
	[CheckSquareIcon, CheckIcon],
	[UserCheckIcon, HandIcon],
	[SquareIcon, XIcon],
]);
const bulkLabels = new Map<RowMenuItem["icon"], string>([
	[CheckSquareIcon, "Allow"],
	[UserCheckIcon, "Ask"],
	[SquareIcon, "Clear"],
]);

/**
 * The agent's bulk actions for the rows shown, as one labeled button group: Allow all, Ask
 * (require approval) and Clear. Each button's tooltip and accessible name say exactly what it
 * changes.
 */
function BulkActions({
	items,
	disabled,
	context,
	shown,
}: {
	items: RowMenuItem[];
	disabled?: boolean;
	context: string;
	/** “3 of 31 shown” while a filter narrows the list. */
	shown?: string;
}) {
	return (
		<fieldset
			aria-label={`Bulk access for ${context}`}
			{...stylex.props(styles.bulk)}
		>
			<span {...stylex.props(styles.bulkLabel)}>
				{shown ? `Set ${shown}:` : "Set all:"}
			</span>
			<span {...stylex.props(styles.bulkGroup)}>
				{items.map((item) => {
					const ItemIcon =
						(item.icon && bulkIcons.get(item.icon)) ?? item.icon ?? CheckIcon;
					return (
						<Tooltip key={item.label} label={item.label}>
							<button
								type="button"
								aria-label={`${item.label} (${context})`}
								disabled={disabled || item.disabled}
								onClick={item.onSelect}
								{...stylex.props(styles.bulkButton)}
							>
								<ItemIcon size={14} aria-hidden="true" />
								{bulkLabels.get(item.icon) ?? item.label}
							</button>
						</Tooltip>
					);
				})}
			</span>
		</fieldset>
	);
}

/** Code-formatted names in one line of text, such as “`a`, `b`”. */
function NameList({ names }: { names: string[] }) {
	return names.map((name, index) => (
		<span key={name}>
			{index ? ", " : ""}
			<code {...stylex.props(styles.starterName)}>{name}</code>
		</span>
	));
}

/**
 * Reviewed starter selections for the connection's catalog entry. Each button adds the
 * starter's tools to the draft in one click, keeping existing access; nothing is saved until
 * Save changes, and the status line names every tool the click changed or left alone.
 */
export function StarterStrip({
	starters,
	applied,
	who,
	full,
	busy,
	onApply,
}: {
	starters: ConnectorStarter[];
	applied: (StarterResult & { name: string }) | null;
	who: string;
	/** “Everything” is on, so a list of names would not narrow anything. */
	full: boolean;
	busy: boolean;
	onApply(starter: ConnectorStarter): void;
}) {
	const id = useId();
	return (
		<section aria-labelledby={`${id}-title`} {...stylex.props(styles.starter)}>
			<div {...stylex.props(styles.starterLine)}>
				<span {...stylex.props(styles.starterHead)}>
					<ListChecksIcon
						size={14}
						aria-hidden="true"
						{...stylex.props(styles.starterIcon)}
					/>
					<span id={`${id}-title`} {...stylex.props(styles.starterTitle)}>
						Suggested starting access
					</span>
				</span>
				{/* The full explanation is the buttons' description; one short note shows when they are off. */}
				<span
					id={`${id}-hint`}
					{...stylex.props(!full && layout.visuallyHidden, styles.starterHint)}
				>
					{full
						? "Turn off “Everything” to use one."
						: "Reviewed by Toolstile as a starting point, not a guarantee. Adds the listed tools to the draft below; existing access stays as it is."}
				</span>
				<ul {...stylex.props(styles.starterList)}>
					{starters.map((starter) => {
						const approval = starter.requireApproval ?? [];
						return (
							<li key={starter.id}>
								<button
									type="button"
									disabled={busy || full}
									aria-describedby={`${id}-hint`}
									title={[
										starter.description,
										`Allow: ${starter.allow.join(", ") || "none"}`,
										...(approval.length
											? [`Require approval: ${approval.join(", ")}`]
											: []),
									].join("\n")}
									onClick={() => onApply(starter)}
									{...stylex.props(styles.starterButton)}
								>
									<span {...stylex.props(styles.starterButtonName)}>
										{starter.name}
									</span>
									<span {...stylex.props(layout.visuallyHidden)}>
										{[
											`${starter.allow.length} allowed`,
											...(approval.length
												? [
														`${approval.length} ${approval.length === 1 ? "requires" : "require"} approval`,
													]
												: []),
										].join(" · ")}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>
			{applied ? (
				<p role="status" {...stylex.props(styles.starterStatus)}>
					<strong {...stylex.props(styles.strong)}>{applied.name}</strong> added
					to the draft for {who}.
					{applied.allowed.length ? (
						<>
							{" "}
							Allowed: <NameList names={applied.allowed} />.
						</>
					) : null}
					{applied.approval.length ? (
						<>
							{" "}
							Require approval: <NameList names={applied.approval} />.
						</>
					) : null}
					{applied.blocked.length ? (
						<>
							{" "}
							Still blocked: <NameList names={applied.blocked} />.
						</>
					) : null}
					{applied.missing.length ? (
						<>
							{" "}
							Not offered by this server now, so left out:{" "}
							<NameList names={applied.missing} />.
						</>
					) : null}{" "}
					Existing access stays as it is, blocks and approval requirements stay
					in force, and it doesn't grant tools the server adds later. Nothing is
					saved until you choose Save changes.
				</p>
			) : null}
		</section>
	);
}

/** A checklist row's name, description and tags. */
function CheckText({
	row,
	kind,
	unsaved = false,
	hint,
	server,
}: {
	row: CapabilityRow;
	kind: Capability;
	/** Typed in by hand and not kept by any rule yet. */
	unsaved?: boolean;
	/** What the server declares about this tool; a tag only, never a default. */
	hint?: ToolHint;
	/** The connection's name, for the hint's source. */
	server?: string;
}) {
	const declared = hint?.destructive
		? "Destructive"
		: hint?.readOnly
			? "Read-only"
			: null;
	return (
		<span {...stylex.props(styles.rowText)}>
			<RowName name={row.name} split={kind === "resources"} />
			{row.description ? (
				<MarkdownPreview
					source={row.description}
					{...stylex.props(styles.rowDescription)}
				/>
			) : null}
			{unsaved ? (
				<span {...stylex.props(styles.rowTag, styles.rowWarning)}>
					Not saved. Choose its access, then save.
				</span>
			) : isTemplate(row.name) ? (
				<span {...stylex.props(styles.rowTag)}>URI template</span>
			) : row.offered === false ? (
				<span {...stylex.props(styles.rowTag, styles.rowWarning)}>
					Not offered by this server now
				</span>
			) : declared ? (
				<span
					title={`Declared by ${server ?? "this server"}. Toolstile does not verify it.`}
					{...stylex.props(
						styles.rowTag,
						declared === "Destructive" && styles.rowWarning,
					)}
				>
					{declared}
				</span>
			) : null}
		</span>
	);
}

/**
 * The empty state for an agent that reaches nothing saved on a connection: one button stages
 * Allow for every tool listed now. It never saves; the save bar applies the draft. The band
 * stays in place once staged and reports the draft's counts instead.
 */
function FirstGrant({
	grant,
	server,
	agent,
	busy,
}: {
	grant: FirstGrantState;
	server: string;
	agent: string;
	busy: boolean;
}) {
	const statusRef = useRef<HTMLParagraphElement>(null);
	const moveFocus = useRef(false);
	// The button leaves with the click, so focus moves to the line that now says what changed.
	useEffect(() => {
		if (grant.staged && moveFocus.current) {
			moveFocus.current = false;
			statusRef.current?.focus({ preventScroll: true });
		}
	}, [grant.staged]);
	const { total, allowed, approval } = grant;
	const tools = `${server} ${total === 1 ? "tool" : "tools"}`;
	const set = allowed + approval;
	const require = `${approval} ${approval === 1 ? "requires" : "require"} approval`;
	const status = !grant.staged
		? `${agent} can’t use ${server} yet.`
		: grant.full
			? `Everything on ${server} set to Allowed for ${agent}, including tools added later. Not saved yet.`
			: !set
				? `${agent} still can’t use ${server}. Your changes are not saved yet.`
				: !approval
					? `${allowed} of ${total} ${tools} set to Allowed for ${agent}. Not saved yet.`
					: !allowed
						? `${approval} of ${total} ${tools} set to Requires approval for ${agent}. Not saved yet.`
						: `${set} of ${total} ${tools} set for ${agent}: ${allowed} allowed, ${require}. Not saved yet.`;
	const action =
		total === 1
			? `Allow the 1 ${server} tool for ${agent}`
			: `Allow all ${total} ${server} tools for ${agent}`;
	return (
		<section
			aria-label={`Access for ${agent} on ${server}`}
			{...stylex.props(styles.firstGrant)}
		>
			<div {...stylex.props(styles.firstGrantText)}>
				<p
					ref={statusRef}
					tabIndex={-1}
					aria-live="polite"
					{...stylex.props(styles.firstGrantTitle)}
				>
					{status}
				</p>
				<p {...stylex.props(styles.firstGrantDetail)}>
					{/* Both states end with the same sentence, so the band keeps its height on staging. */}
					{grant.staged
						? "Save to apply it, or adjust tool by tool below first."
						: `Allow its ${plural(total, "tool")} now, or choose tool by tool below.`}
					{grant.full
						? null
						: ` Tools ${server} adds later stay off until you allow them.`}
				</p>
			</div>
			{grant.staged ? (
				// The same slot as the first button, so the next step is under the pointer and the
				// list below does not move. The save bar offers the same two actions.
				<span {...stylex.props(styles.firstGrantActions)}>
					<button
						type="button"
						disabled={busy || !grant.canSave}
						onClick={grant.save}
						{...stylex.props(controls.button, controls.primary)}
					>
						{busy ? "Saving…" : "Save changes"}
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={grant.discard}
						{...stylex.props(controls.button, controls.quiet)}
					>
						Discard
					</button>
				</span>
			) : (
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						moveFocus.current = true;
						grant.allowAll();
					}}
					{...stylex.props(
						controls.button,
						controls.primary,
						styles.firstGrantButton,
					)}
				>
					<CheckIcon size={16} aria-hidden="true" />
					{action}
				</button>
			)}
		</section>
	);
}

/**
 * A row's identifier on one line. Resource URIs often share a long prefix, so `split` keeps the
 * last path segment whole and shortens the start instead; the title shows the full name.
 */
function RowName({ name, split }: { name: string; split: boolean }) {
	const cut = split ? name.lastIndexOf("/", name.length - 2) + 1 : 0;
	if (cut <= 0)
		return (
			<code title={name} {...stylex.props(styles.rowName)}>
				{name}
			</code>
		);
	return (
		<code title={name} {...stylex.props(styles.rowName, styles.rowNameSplit)}>
			<span {...stylex.props(styles.rowNameHead)}>{name.slice(0, cut)}</span>
			<span {...stylex.props(styles.rowNameTail)}>{name.slice(cut)}</span>
		</code>
	);
}

function cellTitle(state: ReturnType<typeof cellState>, column: string) {
	if (state.blocked === "everyone")
		return "Blocked for every agent. Change it in the Everyone column.";
	if (state.blocked) return `Blocked for ${column}. Check to allow it.`;
	if (state.inherited === "all")
		return `Allowed because everything is allowed for ${column}. Uncheck to block it.`;
	if (state.inherited === "everyone")
		return `Allowed for every agent. Uncheck to block it for ${column} only.`;
	if (state.inherited === "everyone-all")
		return `Allowed because everything is allowed for Everyone. Uncheck to block it for ${column} only.`;
	return undefined;
}

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const mobile = "@media (max-width: 760px)";
const stacked = "@media (max-width: 1100px)";
const coarse = "@media (pointer: coarse)";
// The toolbar stacks the filter above the tabs when the panel itself is narrow.
const toolbarNarrow = "@container (max-width: 479px)";
/** Inline padding of the panel's header, toolbar, notes and add row. */
const panelInset = { default: space.s4, [mobile]: space.s3 };
const spin = stylex.keyframes({
	from: { transform: "rotate(0deg)" },
	to: { transform: "rotate(360deg)" },
});
const slide = stylex.keyframes({
	from: { left: "-30%" },
	to: { left: "100%" },
});
const saveBarIn = stylex.keyframes({
	from: { opacity: 0, transform: "translateY(4px)" },
	to: { opacity: 1, transform: "none" },
});
const fadeIn = stylex.keyframes({
	from: { opacity: 0 },
	to: { opacity: 1 },
});
const pulse = stylex.keyframes({
	"0%": { opacity: 0.55 },
	"50%": { opacity: 1 },
	"100%": { opacity: 0.55 },
});

const styles = stylex.create({
	layout: {
		display: "grid",
		gridTemplateColumns: {
			default: `${size.rail} minmax(0, 1fr)`,
			[stacked]: "minmax(0, 1fr)",
		},
		gridTemplateRows: {
			default: "minmax(0, 1fr)",
			[stacked]: "auto minmax(0, 1fr)",
			[mobile]: "auto auto",
		},
		// One elevated shell holds the connection rail, the tool list and the agent rail,
		// separated by hairlines instead of three floating surfaces.
		gap: 0,
		alignItems: { default: "stretch", [mobile]: "start" },
		backgroundColor: colors.surface,
		borderRadius: geometry.corner,
		boxShadow: elevation.low,
		overflow: { default: "hidden", [mobile]: "visible" },
		// Fills the rest of the page (see the dashboard's `contentFill`).
		flex: "1 1 auto",
		minHeight: 0,
	},
	// A rail on wide screens; a horizontal strip when the page narrows.
	serverList: {
		display: "flex",
		flexDirection: { default: "column", [stacked]: "row" },
		gap: space.s0_5,
		minWidth: 0,
		maxHeight: { default: "100%", [stacked]: "none" },
		overflowX: { default: "visible", [stacked]: "auto" },
		overflowY: { default: "auto", [stacked]: "hidden" },
		scrollbarWidth: "thin",
		flex: "1 1 auto",
		minHeight: 0,
		padding: space.s2,
	},
	serverItem: {
		textDecoration: "none",
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		minWidth: { default: 0, [stacked]: 200 },
		minHeight: size.row,
		padding: `6px ${space.s2}`,
		borderWidth: 0,
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		color: colors.text,
		fontFamily: geometry.fontSans,
		textAlign: "start",
		cursor: "pointer",
		flexShrink: 0,
		transitionProperty: {
			default: "background-color, color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	// The same fill as the main navigation's selected item; no lifted card.
	serverSelected: {
		backgroundColor: {
			default: colors.navSelected,
			":hover": colors.navSelected,
			":focus-visible": colors.navSelected,
		},
		color: colors.action,
	},
	serverText: { display: "grid", minWidth: 0 },
	serverName: {
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 500,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	serverSummary: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontVariantNumeric: "tabular-nums",
		// One line keeps every row the same height; the title shows the rest.
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	// At most the page's remaining height; the matrix scroll box absorbs the difference.
	panel: {
		display: "flex",
		flexDirection: "column",
		maxHeight: { default: "100%", [mobile]: "none" },
		minWidth: 0,
		minHeight: 0,
		containerType: "inline-size",
	},
	// A 44px header row shared with the connection rail and the agent rail, so the three panes
	// start on one baseline above one hairline (the body's top border).
	panelHeader: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr)",
		minHeight: 44,
		flexShrink: 0,
	},
	panelHeaderSplit: {
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 260px",
			[stacked]: "minmax(0, 1fr)",
		},
	},
	panelHeaderMain: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: `${space.s1} ${space.s2}`,
		minWidth: 0,
		minHeight: 44,
		paddingBlock: 6,
		paddingInline: {
			default: `${space.s4} ${space.s3}`,
			[mobile]: `${space.s3} ${space.s2}`,
		},
	},
	// Pane titles: the same quiet label in each column's header row.
	paneHeader: {
		display: "flex",
		alignItems: "center",
		margin: 0,
		minHeight: 44,
		paddingInline: space.s4,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		flexShrink: 0,
	},
	reachHeader: {
		display: { default: "flex", [stacked]: "none" },
		borderLeftWidth: 1,
		borderLeftStyle: "solid",
		borderLeftColor: colors.line,
	},
	serverPane: {
		display: "flex",
		flexDirection: "column",
		minWidth: 0,
		minHeight: 0,
		borderRightWidth: { default: 1, [stacked]: 0 },
		borderBottomWidth: { default: 0, [stacked]: 1 },
		borderTopWidth: 0,
		borderLeftWidth: 0,
		borderStyle: "solid",
		borderColor: colors.line,
	},
	serverPaneHeader: {
		display: { default: "flex", [stacked]: "none" },
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	panelTitle: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		margin: 0,
		minWidth: 0,
		fontSize: text.body,
		lineHeight: "24px",
		fontWeight: 500,
		outline: "none",
		overflowWrap: "anywhere",
	},
	// The connection is context in the breadcrumb; the agent after the slash is the subject.
	crumbServer: { color: colors.muted, fontWeight: 400 },
	crumbSeparator: { color: colors.line, fontWeight: 400 },
	crumbAgent: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s2,
		minWidth: 0,
	},
	crumbAgentName: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	crumbMark: { width: 20, height: 20 },
	crumbDevice: {
		minWidth: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	},
	// Empty while idle; it also pushes Refresh to the end of the header line.
	panelMeta: {
		flex: "1 1 0",
		minWidth: 0,
		margin: 0,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontVariantNumeric: "tabular-nums",
		overflowWrap: "anywhere",
	},
	// Phones get a 44px target from negative margins, so the header line keeps its height.
	refresh: {
		marginInlineStart: "auto",
		minWidth: { default: size.controlSm, [mobile]: 44 },
		minHeight: { default: size.controlSm, [mobile]: 44 },
		marginBlock: { default: 0, [mobile]: -8 },
	},
	spinning: {
		animationName: { default: spin, [reducedMotion]: "none" },
		animationDuration: "900ms",
		animationTimingFunction: "linear",
		animationIterationCount: "infinite",
	},
	catalogError: {
		marginBlock: `${space.s1} ${space.s2}`,
		marginInline: panelInset,
	},
	catalogErrorBody: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: space.s2,
	},
	catalogErrorText: {
		flex: "1 1 240px",
		minWidth: 0,
		margin: 0,
		overflowWrap: "anywhere",
	},
	strong: { fontWeight: 600 },
	inlineActions: { display: "flex", gap: space.s2, flexWrap: "wrap" },
	// The tabs' own underline overlaps this row's bottom line, so there is one hairline.
	toolbar: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) minmax(160px, 240px)",
			[toolbarNarrow]: "minmax(0, 1fr)",
		},
		gridTemplateAreas: {
			default: '"tabs search"',
			[toolbarNarrow]: '"search" "tabs"',
		},
		alignItems: "end",
		minHeight: 44,
		columnGap: space.s3,
		paddingInline: panelInset,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	tabs: { gridArea: "tabs", minWidth: 0, marginBottom: -1 },
	search: {
		gridArea: "search",
		position: "relative",
		display: "block",
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
		height: size.control,
		minHeight: size.control,
		boxSizing: "border-box",
		paddingInlineStart: space.s8,
	},
	note: {
		marginBlock: space.s3,
		marginInline: panelInset,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	linkButton: {
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: colors.action,
		font: "inherit",
		textDecoration: "underline",
		textUnderlineOffset: 2,
		cursor: "pointer",
	},
	rowText: { display: "grid", gap: space.s0_5, flex: 1, minWidth: 0 },
	// Identifiers never wrap; the title shows the full name.
	rowName: {
		display: "block",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontFamily: geometry.fontMono,
		fontSize: 13,
		lineHeight: "20px",
		color: colors.text,
	},
	rowNameSplit: { display: "flex", minWidth: 0 },
	// The shared prefix gives way first, down to a few characters; a tail longer than the
	// rest of the column ends in an ellipsis.
	rowNameHead: {
		flexShrink: 1,
		minWidth: "3ch",
		overflow: "hidden",
		textOverflow: "ellipsis",
	},
	rowNameTail: {
		flexShrink: 0,
		maxWidth: "calc(100% - 3ch)",
		overflow: "hidden",
		textOverflow: "ellipsis",
	},
	rowDescription: {
		display: "-webkit-box",
		WebkitLineClamp: 1,
		WebkitBoxOrient: "vertical",
		overflow: "hidden",
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
	},
	rowTag: {
		justifySelf: "start",
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	rowWarning: { color: colors.warning },
	// One agent: checklist beside the per-agent reach panel; phones stack them.
	agentLayout: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 260px",
			[stacked]: "minmax(0, 1fr)",
		},
		flex: "1 1 auto",
		minHeight: 0,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: colors.line,
	},
	// The middle column: the pinned toolbar over the scrolling list, with a soft fade at the
	// bottom edge so a row cut by the panel's end reads as "more below", not as clipped.
	agentColumn: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		minWidth: 0,
		minHeight: 0,
		"::after": {
			content: { default: '""', [mobile]: "none" },
			position: "absolute",
			insetInline: 0,
			bottom: 0,
			height: 40,
			backgroundImage: `linear-gradient(to bottom, color-mix(in srgb, ${colors.surface} 0%, transparent), color-mix(in srgb, ${colors.surface} 85%, transparent) 60%, ${colors.surface})`,
			borderEndStartRadius: geometry.corner,
			pointerEvents: "none",
		},
	},
	agentMain: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		gap: space.s3,
		flex: "1 1 auto",
		minWidth: 0,
		minHeight: 0,
		overflowY: { default: "auto", [mobile]: "visible" },
		padding: space.s4,
		// Room under the last row so the fade sits over padding when scrolled to the end.
		paddingBottom: space.s8,
	},
	// Applies to the Everything control above it: blocks win over “Everything”.
	fullNote: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	agentHead: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		flexWrap: "wrap",
		gap: space.s3,
		outline: "none",
	},
	// Bulk actions for the shown rows: a muted lead-in, then one joined button group.
	bulk: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s2,
		minWidth: 0,
		margin: 0,
		padding: 0,
		borderWidth: 0,
	},
	bulkLabel: {
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap",
	},
	bulkGroup: {
		display: "inline-flex",
		alignItems: "center",
		height: { default: 32, [coarse]: "auto" },
		boxSizing: "border-box",
		padding: 2,
		gap: 2,
		borderRadius: geometry.corner,
		backgroundColor: colors.insetTint,
	},
	bulkButton: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		height: { default: 28, [coarse]: 44 },
		paddingInline: 10,
		borderWidth: 0,
		borderRadius: geometry.cornerSmall,
		backgroundColor: {
			default: "transparent",
			":hover": colors.surface,
			":focus-visible": colors.surface,
		},
		boxShadow: {
			default: "none",
			":hover": elevation.low,
			":focus-visible": elevation.low,
		},
		color: {
			default: colors.muted,
			":hover": colors.text,
			":focus-visible": colors.text,
			":disabled": colors.muted,
		},
		opacity: { default: 1, ":disabled": 0.5 },
		fontFamily: geometry.fontSans,
		fontSize: 13,
		lineHeight: "20px",
		fontWeight: 500,
		whiteSpace: "nowrap",
		cursor: { default: "pointer", ":disabled": "default" },
		outline: "none",
	},
	// Reviewed starters: a flat group under the agent, set off by spacing and a hairline.
	starter: {
		display: "grid",
		gap: 6,
		flex: "0 1 auto",
		minWidth: 0,
	},
	// The starters and the block rule share one quiet line, closed by a hairline.
	hintRow: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		justifyContent: "space-between",
		columnGap: space.s4,
		rowGap: 6,
		paddingBottom: space.s3,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	starterLine: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		columnGap: space.s2,
		rowGap: 2,
		minWidth: 0,
	},
	rowNameCell: { cursor: "default" },
	iconActions: { display: "inline-flex", gap: 2, flexShrink: 0 },
	iconActionsReveal: {
		opacity: {
			default: 0,
			":focus-within": 1,
			[stylex.when.ancestor(":hover")]: 1,
			[coarse]: 1,
		},
		transitionProperty: { default: "opacity", [reducedMotion]: "none" },
		transitionDuration: motion.fast,
	},
	iconAction: { color: colors.muted },

	starterHead: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		flexShrink: 0,
	},
	starterIcon: { color: colors.muted, flexShrink: 0 },
	starterTitle: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
	},
	starterHint: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	starterList: {
		display: "flex",
		flexWrap: "wrap",
		gap: 2,
		margin: 0,
		// Text buttons: their labels line up with the heading, the hover wash reaches past.
		marginInlineStart: -8,
		padding: 0,
		listStyle: "none",
		minWidth: 0,
	},
	// Focus looks like hover: a tint, no outline ring.
	starterButton: {
		display: "inline-flex",
		alignItems: "baseline",
		gap: 6,
		maxWidth: "100%",
		minHeight: { default: 24, [coarse]: 44 },
		paddingBlock: 3,
		paddingInline: space.s2,
		borderWidth: 0,
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
			":disabled": "transparent",
		},
		outline: "none",
		color: { default: colors.action, ":disabled": colors.muted },
		fontFamily: geometry.fontSans,
		textAlign: "start",
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		transitionProperty: {
			default: "background-color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	starterButtonName: {
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
	},
	starterStatus: {
		margin: 0,
		color: colors.text,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		overflowWrap: "anywhere",
	},
	starterName: {
		fontFamily: geometry.fontMono,
		fontSize: text.meta,
		whiteSpace: "nowrap",
	},
	everyoneMark: {
		display: "grid",
		placeItems: "center",
		width: 28,
		height: 28,
		flexShrink: 0,
		borderRadius: geometry.corner,
		backgroundColor: colors.actionTint,
		color: colors.action,
	},
	agentFull: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s2,
		minHeight: { default: size.control, [coarse]: 44 },
		fontSize: text.body,
		lineHeight: text.bodyLeading,
		fontWeight: 500,
		cursor: "pointer",
		// Phones wrap the label rather than push the row wider than the screen.
		whiteSpace: { default: "nowrap", [mobile]: "normal" },
	},
	// Two columns of rows in one frame, like the demo's tool list.
	checklist: {
		listStyle: "none",
		margin: 0,
		display: "grid",
		gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))",
		columnGap: space.s6,
		padding: 0,
	},
	checkRow: {
		position: "relative",
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		// Fits a name and a one-line description, so rows keep their height either way.
		minHeight: 56,
		boxSizing: "border-box",
		paddingBlock: 4,
		paddingInlineStart: 0,
		minWidth: 0,
		borderBottomWidth: { default: 1, ":last-child": 0 },
		borderBottomStyle: "solid",
		borderBottomColor: colors.line,
	},
	// The same unsaved mark as a grid cell: a dashed action outline. It reaches 8px past the row
	// on each side (into the list's padding and column gap), so names never touch it and nothing
	// in the row moves when it appears.
	checkRowChanged: {
		"::before": {
			content: '""',
			position: "absolute",
			top: 0,
			bottom: -1,
			insetInline: `calc(-1 * ${space.s2})`,
			borderWidth: 1,
			borderStyle: "dashed",
			borderColor: colors.action,
			borderRadius: geometry.cornerSmall,
			pointerEvents: "none",
		},
	},
	checkLabel: {
		display: "flex",
		alignItems: "center",
		gap: space.s3,
		flex: "1 1 auto",
		minWidth: 0,
		cursor: "pointer",
		paddingTop: 2,
	},
	modeChip: {
		display: "inline-flex",
		alignItems: "center",
		gap: 4,
		flexShrink: 0,
		height: 22,
		paddingInline: 8,
		borderWidth: 0,
		borderRadius: geometry.cornerSmall,
		fontFamily: geometry.fontSans,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
		whiteSpace: "nowrap",
		cursor: "pointer",
		outline: "none",
		// The fill comes from the tone variant, so hover and keyboard focus lay the hover wash over it.
		backgroundImage: {
			default: "none",
			":hover": `linear-gradient(${colors.hoverOverlay}, ${colors.hoverOverlay})`,
			":focus-visible": `linear-gradient(${colors.hoverOverlay}, ${colors.hoverOverlay})`,
		},
	},
	// The common case stays neutral; colour is kept for approval and blocks.
	chip_allowed: {
		color: colors.text,
		backgroundColor: colors.insetTint,
	},
	chip_approval: {
		color: colors.warning,
		backgroundColor: colors.warningTint,
	},
	chip_blocked: {
		color: colors.bad,
		backgroundColor: `color-mix(in srgb, ${colors.bad} 12%, transparent)`,
	},
	chip_off: { color: colors.muted, backgroundColor: "transparent" },
	chip_inheritedNote: {
		color: colors.muted,
		backgroundColor: colors.insetTint,
		cursor: "default",
	},
	// Inherited modes drop their fill for a hairline edge, lighter than the agent's own choice.
	// Rows that only follow “Everything”: the whole state column steps back to secondary text.
	chipMuted: {
		color: colors.muted,
		backgroundColor: "transparent",
		fontWeight: 400,
		// At rest a quiet muted label, text only; the icon, caret and edge appear on row hover,
		// keyboard focus and touch screens (chipReveal handles the icon and caret).
		boxShadow: {
			default: "none",
			":focus-visible": `inset 0 0 0 1px ${colors.controlBorderHover}`,
			[stylex.when.ancestor(":hover")]:
				`inset 0 0 0 1px ${colors.controlBorder}`,
		},
	},
	// The icon and caret of a quiet state appear with the row's hover or the trigger's focus.
	chipReveal: {
		opacity: {
			default: 0,
			[stylex.when.ancestor(":hover")]: 1,
			[stylex.when.ancestor(":focus-within")]: 1,
			[coarse]: 1,
		},
		transitionProperty: { default: "opacity", [reducedMotion]: "none" },
		transitionDuration: motion.fast,
	},
	chipInherited: {
		backgroundColor: "transparent",
		boxShadow: `inset 0 0 0 1px ${colors.line}`,
		color: colors.muted,
	},
	// “Allowed” is the common case: a ghost trigger at rest that shows its edge when the row is
	// hovered or the trigger has keyboard focus, so 30 identical bordered chips never stack up.
	chipQuiet: {
		backgroundColor: "transparent",
		boxShadow: {
			default: "none",
			":focus-visible": `inset 0 0 0 1px ${colors.controlBorderHover}`,
			[stylex.when.ancestor(":hover")]:
				`inset 0 0 0 1px ${colors.controlBorder}`,
		},
	},
	loadingStatus: {
		display: "inline-flex",
		alignItems: "center",
		gap: space.s2,
		maxWidth: "100%",
		color: colors.action,
		fontWeight: 500,
	},
	loadingText: {
		minWidth: 0,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	},
	// Placeholder rows match a real row's parts and height, so the swap does not move anything.
	placeholder: {
		display: "block",
		borderRadius: geometry.cornerSmall,
		backgroundColor: colors.lineTint,
		animationName: { default: pulse, [reducedMotion]: "none" },
		animationDuration: "1.4s",
		animationIterationCount: "infinite",
	},
	placeholderBox: { width: 16, height: 16, flexShrink: 0 },
	placeholderText: {
		display: "grid",
		gap: 6,
		flex: "1 1 auto",
		minWidth: 0,
		paddingInlineStart: space.s1,
	},
	placeholderLine: { height: 10, maxWidth: "100%" },
	placeholderWidth: (percent: number) => ({ width: `${percent}%` }),
	placeholderChip: { width: 72, height: 22, flexShrink: 0 },
	placeholderValue: { width: 40, height: 10, marginTop: 5 },
	// Refreshing over a shown catalog: a thin moving bar instead of a layout change.
	refreshBar: {
		position: "absolute",
		top: 0,
		insetInline: 0,
		height: 2,
		overflow: "hidden",
		backgroundColor: colors.actionTint,
		"::after": {
			content: '""',
			position: "absolute",
			top: 0,
			bottom: 0,
			width: "30%",
			backgroundColor: colors.action,
			animationName: { default: slide, [reducedMotion]: "none" },
			animationDuration: "1.1s",
			animationTimingFunction: "ease-in-out",
			animationIterationCount: "infinite",
		},
	},
	agentEmpty: {
		margin: 0,
		paddingBlock: space.s6,
		color: colors.muted,
		textAlign: "center",
		fontSize: text.body,
	},
	reachPanel: {
		display: "flex",
		flexDirection: "column",
		gap: space.s3,
		minWidth: 0,
		padding: space.s4,
		borderLeftWidth: { default: 1, [stacked]: 0 },
		borderTopWidth: { default: 0, [stacked]: 1 },
		borderRightWidth: 0,
		borderBottomWidth: 0,
		borderStyle: "solid",
		borderColor: colors.line,
		overflowY: { default: "auto", [mobile]: "visible" },
	},
	reachTitle: {
		display: { default: "none", [stacked]: "block" },
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
	},
	reachList: {
		listStyle: "none",
		margin: 0,
		padding: 0,
		display: "grid",
		// Items may shrink, so long agent names truncate instead of pushing the counts out.
		gridTemplateColumns: "minmax(0, 1fr)",
		gap: 2,
	},
	reachGroup: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr)",
		gap: space.s1,
		marginTop: space.s2,
	},
	reachDeviceName: {
		flex: "0 1 auto",
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	// Group band: the shared band fill, 32px, a 12px/500 muted label and a "· N" count.
	reachDevice: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minHeight: 32,
		paddingInlineStart: space.s3,
		paddingInlineEnd: space.s1,
		borderRadius: geometry.corner,
		backgroundColor: colors.band,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
	},
	// Pushes the device menu to the band's end.
	reachDeviceCount: {
		flexShrink: 0,
		marginInlineEnd: "auto",
		fontWeight: 400,
		fontVariantNumeric: "tabular-nums",
	},
	reachItem: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr)",
		minWidth: 0,
		gap: 6,
		width: "100%",
		padding: `${space.s2} ${space.s3} 10px`,
		boxSizing: "border-box",
		borderWidth: 0,
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		color: colors.text,
		fontFamily: geometry.fontSans,
		textAlign: "start",
		cursor: "pointer",
		outline: "none",
	},
	reachSelected: {
		backgroundColor: {
			default: colors.navSelected,
			":hover": colors.navSelected,
			":focus-visible": colors.navSelected,
		},
	},
	reachHead: {
		display: "flex",
		justifyContent: "space-between",
		gap: space.s2,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	reachName: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		flex: "1 1 auto",
		fontWeight: 500,
		minWidth: 0,
	},
	reachNameText: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	reachValue: {
		color: colors.muted,
		fontSize: text.meta,
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap",
	},
	reachMeta: {
		color: colors.action,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	// A 3px full-width track under the label; selection is the row fill alone.
	meter: {
		display: "block",
		height: 3,
		borderRadius: 999,
		backgroundColor: colors.line,
		overflow: "hidden",
	},
	meterFill: {
		display: "block",
		height: "100%",
		borderRadius: 999,
		backgroundColor: `color-mix(in srgb, ${colors.action} 70%, transparent)`,
		transitionProperty: { default: "width", [reducedMotion]: "none" },
		transitionDuration: motion.slow,
	},
	meterWidth: (percent: number) => ({ width: `${percent}%` }),

	modeMenu: { maxWidth: "min(320px, var(--available-width))" },
	modeMenuLabel: {
		display: "block",
		padding: `${space.s1} ${space.s3}`,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		overflowWrap: "anywhere",
	},
	modeMenuName: {
		marginInlineEnd: space.s1,
		color: colors.text,
		fontFamily: geometry.fontMono,
	},
	modeItem: { alignItems: "flex-start" },
	modeItemIcon: { flexShrink: 0, marginTop: 2 },
	modeItemText: {
		display: "grid",
		gap: space.s0_5,
		flex: 1,
		minWidth: 0,
		fontSize: text.body,
		lineHeight: text.bodyLeading,
	},
	modeItemDetail: {
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	modeItemCheck: { flexShrink: 0, marginTop: 2, color: colors.action },
	addRow: {
		display: "flex",
		alignItems: "flex-end",
		flexWrap: "wrap",
		gap: space.s2,
		paddingTop: space.s1,
	},
	addInset: { padding: panelInset, paddingTop: space.s3 },
	addLabel: {
		display: "grid",
		gap: space.s1,
		flex: "0 1 360px",
		minWidth: 180,
	},
	addText: {
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	addInput: { fontFamily: geometry.fontMono },
	// Its own line under the field and button.
	addHint: {
		flexBasis: "100%",
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		overflowWrap: "anywhere",
	},
	addError: { color: colors.bad },
	// Pinned to the panel's bottom while there are unsaved edits: in a bounded panel it closes
	// the column, and where the page scrolls (phones) it sticks to the viewport's bottom edge.
	saveBar: {
		position: "sticky",
		bottom: 0,
		zIndex: 1,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		flexWrap: "wrap",
		gap: `${space.s1} ${space.s3}`,
		flexShrink: 0,
		minHeight: 44,
		boxSizing: "border-box",
		paddingBlock: 6,
		paddingInline: panelInset,
		backgroundColor: colors.surface,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: colors.line,
		borderEndStartRadius: { default: 0, [mobile]: geometry.corner },
		borderEndEndRadius: { default: 0, [mobile]: geometry.corner },
		animationName: { default: saveBarIn, [reducedMotion]: fadeIn },
		animationDuration: motion.enter,
		animationTimingFunction: motion.settle,
	},
	saveText: {
		marginBlock: 0,
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
		fontVariantNumeric: "tabular-nums",
	},
	saveActions: {
		display: "flex",
		alignItems: "center",
		gap: space.s1,
		marginInlineStart: "auto",
	},
	// One muted line that defines the three states in the page's own words.
	modeHelp: {
		margin: 0,
		marginTop: `calc(-1 * ${space.s1})`,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	// A flat band inside the panel: tinted, no border or shadow, so it is not another card.
	firstGrant: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: `${space.s3} ${space.s4}`,
		paddingBlock: space.s3,
		paddingInline: space.s4,
		borderRadius: geometry.corner,
		backgroundColor: colors.band,
	},
	firstGrantText: {
		display: "grid",
		gap: space.s0_5,
		flex: "1 1 280px",
		minWidth: 0,
	},
	firstGrantTitle: {
		margin: 0,
		color: colors.text,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 500,
		outline: "none",
		overflowWrap: "anywhere",
	},
	firstGrantDetail: {
		margin: 0,
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
		overflowWrap: "anywhere",
	},
	firstGrantActions: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: space.s1,
	},
	// Long agent and connection names wrap inside the button instead of widening the band.
	firstGrantButton: {
		flex: "0 1 auto",
		maxWidth: "100%",
		height: "auto",
		minHeight: size.control,
		paddingBlock: 6,
		whiteSpace: "normal",
		textAlign: "start",
	},
	// “Everything” and add-by-name, collapsed under one quiet toggle at the end of the list.
	moreOptions: { display: "grid", gap: space.s2, minWidth: 0 },
	moreToggle: {
		display: "inline-flex",
		alignItems: "center",
		flexWrap: "wrap",
		justifySelf: "start",
		columnGap: space.s2,
		rowGap: 0,
		maxWidth: "100%",
		minHeight: size.control,
		marginInlineStart: `calc(-1 * ${space.s2})`,
		paddingBlock: space.s1,
		paddingInline: space.s2,
		borderWidth: 0,
		borderRadius: geometry.corner,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hoverOverlay,
			":focus-visible": colors.hoverOverlay,
		},
		outline: "none",
		color: colors.text,
		fontFamily: geometry.fontSans,
		fontSize: 13,
		lineHeight: "20px",
		fontWeight: 500,
		textAlign: "start",
		cursor: "pointer",
		transitionProperty: {
			default: "background-color",
			[reducedMotion]: "none",
		},
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	moreCaret: {
		flexShrink: 0,
		color: colors.muted,
		transitionProperty: { default: "transform", [reducedMotion]: "none" },
		transitionDuration: motion.base,
		transitionTimingFunction: motion.easeOut,
	},
	moreCaretOpen: { transform: "rotate(90deg)" },
	moreSummary: { color: colors.muted, fontWeight: 400 },
	moreBody: {
		display: "grid",
		justifyItems: "start",
		gap: space.s2,
		minWidth: 0,
		paddingInlineStart: space.s4,
	},
	collapsed: { display: "none" },
	// Toolstile's own tools: a 32px band header, one sentence, then rows in the list's layout.
	builtIn: { display: "grid", gap: space.s2, minWidth: 0 },
	builtInBand: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minHeight: 32,
		margin: 0,
		paddingInline: space.s3,
		borderRadius: geometry.corner,
		backgroundColor: colors.band,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		fontWeight: 500,
	},
	builtInCount: { fontWeight: 400, fontVariantNumeric: "tabular-nums" },
	builtInNote: {
		margin: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	builtInReads: {
		color: colors.muted,
		fontSize: 13,
		lineHeight: "20px",
	},
	// Where a tool's mode chip sits: a plain label, not a control.
	builtInState: {
		flexShrink: 0,
		color: colors.muted,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
		whiteSpace: "nowrap",
	},
});
