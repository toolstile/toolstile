import {
	CopyIcon,
	PlusIcon,
	WarningCircleIcon,
	XIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import type { ManagementClient } from "@toolstile/api/client";
import type { ConnectorClient } from "@toolstile/api/connector-client";
import type {
	AccessSearch,
	ConnectionPreview,
	DashboardDialog,
	Snapshot,
} from "@toolstile/api/contract";
import {
	type FormEvent,
	Fragment,
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	CatalogState,
	EveryoneAccess,
	StarterLoader,
} from "./AccessManager";
import type { ActivityView } from "./ActivityPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ComputerSetup } from "./ConnectAgent";
import { ConnectionCheckNote } from "./ConnectionAddress";
import { controls } from "./Control.styles";
import { CopyValue } from "./CopyValue";
import { readCatalogCache, writeCatalogCache } from "./catalog-cache";
import { dashboardStyles as styles } from "./Dashboard.styles";
import {
	type AccessLinkRenderer,
	type DashboardConfirmation,
	DashboardContext,
	type DashboardContextValue,
} from "./DashboardContext";
import { DashboardFrame } from "./DashboardFrame";
import { Disclosure } from "./Disclosure";
import { ModalFrame } from "./ModalFrame";
import {
	type DashboardLinks,
	type DashboardNavigationGroup,
	type DashboardNavigationItem,
	defaultDashboardLinks,
	defaultNavigationGroups,
	type ExtraNavigationItem,
	MainNavigation,
	navigationEntries,
	navigationIconItem,
	navigationItem,
	SidebarLinks,
} from "./Navigation";
import { Notice, PageHeader } from "./Primitives";
import { leaveForSignIn } from "./provider-sign-in";
import { useScopedState } from "./ScopedState";
import { SelectField } from "./SelectField";
import {
	authorizationRefused,
	connectionStatus,
	connectionUnreachable,
	defaultAccessConnection,
	readServerAddress,
	sameServerAddress,
	specificMessage,
	toolsLoadable,
} from "./status";
import { useToastFeedback } from "./Toast";
import { colors, space, text, typeScale } from "./tokens.stylex";
import type { AccountMenuProps } from "./UserMenu";

// Dialogs opened on demand load with their first use, outside the layout's bundle.
const ConnectAgentDialog = lazy(() =>
	import("./ConnectAgent").then((module) => ({
		default: module.ConnectAgentDialog,
	})),
);
const ToolTest = lazy(() =>
	import("./ToolTest").then((module) => ({ default: module.ToolTest })),
);
const UpstreamSignIn = lazy(() =>
	import("./UpstreamSignIn").then((module) => ({
		default: module.UpstreamSignIn,
	})),
);

/** One-line page subheadings; no trailing period. */
const descriptions: Record<string, string> = {
	connections:
		"Connect MCP servers once, then choose which agents can use each",
	devices: "Agents grouped by the device they run on",
	access: "What each agent may use on each MCP connection",
	activity: "Recent requests through the gateway",
};

export function Dashboard({
	section,
	onNavigate,
	renderNavigationLink,
	renderHomeLink,
	modal: requestedModal,
	selectedConnectionId,
	selectedToolName,
	testAgentId,
	oauthStatus,
	oauthConnectionId,
	onOAuthStatusConsumed,
	onDialogChange,
	accessView,
	onAccessViewChange,
	renderAccessLink,
	everyoneAccess,
	loadStarters,
	data,
	api,
	connectionRequests,
	reload,
	renderAccountMenu,
	extraNavigation = [],
	pageError,
	browsingCatalog = false,
	onBrowseConnectors,
	navigationGroups = defaultNavigationGroups,
	sidebarFooter,
	sidebarTrailing,
	links,
	endpoint,
	computerSetup,
	pending,
	scopeKey = "",
	accessNavigation,
	connectionAccessSummary,
	onSignOut,
	activity,
	children,
}: {
	section: string;
	onNavigate(section: string): void;
	renderNavigationLink(item: DashboardNavigationItem): ReactNode;
	/** Router link around the sidebar brand, leading to the home page. */
	renderHomeLink?(link: { className: string; children: ReactNode }): ReactNode;
	modal: DashboardDialog | null;
	selectedConnectionId?: string;
	selectedToolName?: string;
	testAgentId?: string;
	oauthStatus?: "connected" | "failed";
	/** The connection a completed browser sign-in returned for; it is highlighted with a next step. */
	oauthConnectionId?: string;
	onOAuthStatusConsumed?(): void;
	onDialogChange(
		dialog: DashboardDialog | null,
		selection?: { agentId?: string; connectionId?: string; toolName?: string },
	): void;
	/** Access page view from the URL: selected server, capability tab and filter. */
	accessView: AccessSearch;
	/** Opens the access page with this view; `replace` is set while typing a filter. */
	onAccessViewChange(
		view: AccessSearch,
		replace?: boolean,
		focusAgentId?: string,
	): void;
	/** Router link to the access page for one server, used on the devices page. */
	renderAccessLink: AccessLinkRenderer;
	/** Adds the Everyone column for rules that apply to all of the user's agents. */
	everyoneAccess?: EveryoneAccess;
	/** Reviewed starter selections offered in the access editor, where the host loads them. */
	loadStarters?: StarterLoader;
	data: Snapshot;
	api: ManagementClient;
	/** The URL dialog checks an address, then saves exactly the confirmed one. */
	connectionRequests: Pick<
		ConnectorClient,
		"previewConnection" | "connectConnector"
	>;
	reload(): Promise<void>;
	/** The account button and menu under the sidebar brand, such as `UserMenu`. */
	renderAccountMenu(menu: AccountMenuProps): ReactNode;
	/** Extra sections; `description` is the one-line subheading under the page title. */
	extraNavigation?: ExtraNavigationItem[];
	/**
	 * The host's page-level error, such as newer data that failed to load behind `pending`. It
	 * takes the page's error notice; the host clears it, so it has no dismiss button.
	 */
	pageError?: string;
	/** Activity page view from the URL and its debug capture tab. */
	activity?: {
		view: ActivityView;
		onViewChange(view: ActivityView, replace?: boolean): void;
		debug?: { selectedPayloadId?: string; onSelectPayload(id?: string): void };
	};
	/** The connections section shows the connector catalog; its header has no add button. */
	browsingCatalog?: boolean;
	onBrowseConnectors?(): void;
	/** Sidebar groups by navigation id; Settings always sits in the bottom row. */
	navigationGroups?: DashboardNavigationGroup[];
	/** Sidebar slot between the navigation and the bottom links, such as the docked setup card. */
	sidebarFooter?: ReactNode;
	/** Icon buttons at the end of the bottom row, after Settings, Docs and Help. */
	sidebarTrailing?: ReactNode;
	links?: DashboardLinks;
	/** MCP endpoint shown in the Connect an agent dialog; defaults to this origin's `/mcp`. */
	endpoint?: string;
	/** The host's own way to set up every agent on a computer, offered first in Connect an agent. */
	computerSetup?: ComputerSetup;
	/**
	 * Announced while newer data loads behind this snapshot. The page
	 * becomes inert and dims; the sidebar stays usable.
	 */
	pending?: string;
	/** Identifies the current authorization context without remounting the sidebar. */
	scopeKey?: string;
	/** Host router blocker covers links, setup navigation and browser history. */
	accessNavigation?: {
		onDirtyChange(dirty: boolean): void;
		blocked?: { proceed(): void; reset(): void };
	};
	/**
	 * Access summary for one connection, such as "2 agents have access". The host decides
	 * which rules count; `short` is the compact form for the access page's server list.
	 */
	connectionAccessSummary(connectionId: string, short?: boolean): string;
	onSignOut(): void;
	/**
	 * The current page, such as the router's outlet. Pages read the shared state through
	 * `useDashboard`; settings pages bring their own column and heading.
	 */
	children?: ReactNode;
}) {
	const localScope = JSON.stringify([
		section,
		scopeKey,
		section === "access"
			? (accessView.server ?? defaultAccessConnection(data.connections)?.id)
			: undefined,
		data.user.email,
		Boolean(pending),
	]);
	const activeScope = useRef({ key: localScope });
	if (activeScope.current.key !== localScope)
		activeScope.current = { key: localScope };
	const generation = activeScope.current;
	const modal = pending ? null : requestedModal;
	const [error, setError] = useScopedState(localScope, ""),
		[busy, setBusy] = useScopedState(localScope, false),
		[token, setToken] = useScopedState(localScope, ""),
		[tokenAgentId, setTokenAgentId] = useScopedState(localScope, "");
	const setNotice = useToastFeedback(localScope);
	const [navigationOverflows, setNavigationOverflows] = useState(false);
	const navigationRef = useRef<HTMLElement>(null);
	// Local dialog and row-edit state; the URL never carries them.
	const [connectOpen, setConnectOpen] = useScopedState(localScope, false);
	/** Pending destructive action awaiting the in-app confirmation. */
	const [confirming, setConfirming] =
		useScopedState<DashboardConfirmation | null>(localScope, null);
	const [tokenDeviceId, setTokenDeviceId] = useScopedState(localScope, "");
	const [tokenErrors, setTokenErrors] = useScopedState<TokenFieldErrors>(
		localScope,
		{},
	);
	const [renaming, setRenaming] = useScopedState<{
		kind: "device" | "agent";
		id: string;
	} | null>(localScope, null);
	const restoreFocus = useRef("");
	// useScopedState resets dialog drafts and secrets when localScope changes.
	useEffect(() => {
		if (renaming || !restoreFocus.current) return;
		const id = restoreFocus.current;
		restoreFocus.current = "";
		// Leave focus alone when the field closed because the person clicked elsewhere.
		if (document.activeElement && document.activeElement !== document.body)
			return;
		document
			.querySelector<HTMLElement>(
				`[data-rename-anchor="${CSS.escape(id)}"] [data-rename-trigger]`,
			)
			?.focus();
	}, [renaming]);
	function finishRename(id: string) {
		restoreFocus.current = id;
		setRenaming(null);
	}
	async function rename(kind: "device" | "agent", id: string, label: string) {
		const saved = await run(
			() =>
				kind === "device"
					? api.renameDevice({ id, label })
					: api.renameAgent({ id, label }),
			kind === "device" ? "Device renamed" : "Agent renamed",
		);
		if (saved) finishRename(id);
	}
	function createToken(deviceId = "") {
		setConnectOpen(false);
		setTokenDeviceId(deviceId);
		setTokenErrors({});
		onDialogChange("agent");
	}
	useEffect(() => {
		if (modal) setToken("");
	}, [modal, setToken]);
	// selection and item-count changes alter the DOM measured and revealed by this observer.
	useEffect(() => {
		const navigation = navigationRef.current;
		if (!navigation) return;
		const current = navigation.querySelector<HTMLElement>(
			'[aria-current="page"]',
		);
		function revealSelection() {
			if (!navigation) return;
			const mobile = matchMedia("(max-width: 760px)").matches;
			setNavigationOverflows(
				!mobile && navigation.scrollHeight > navigation.clientHeight + 1,
			);
			if (!current) return;
			const item = current.getBoundingClientRect();
			const viewport = navigation.getBoundingClientRect();
			if (mobile) {
				if (item.left < viewport.left + 6)
					navigation.scrollLeft += item.left - viewport.left - 6;
				else if (item.right > viewport.right - 6)
					navigation.scrollLeft += item.right - viewport.right + 6;
			} else {
				if (item.top < viewport.top + 6)
					navigation.scrollTop += item.top - viewport.top - 6;
				else if (item.bottom > viewport.bottom - 6)
					navigation.scrollTop += item.bottom - viewport.bottom + 6;
			}
		}
		revealSelection();
		const observer = new ResizeObserver(revealSelection);
		observer.observe(navigation);
		return () => observer.disconnect();
	}, [section, extraNavigation.length]);
	async function run(work: () => Promise<unknown>, success = "Saved") {
		if (pending || activeScope.current !== generation) return false;
		setBusy(true);
		setError("");
		try {
			await work();
			if (activeScope.current !== generation) return false;
			// The change is saved; a failed refresh only leaves the page out of date, so it must
			// not read as a failed change that invites repeating it.
			const refreshed = await reload().then(
				() => true,
				() => false,
			);
			if (activeScope.current !== generation) return false;
			setNotice(
				refreshed
					? success
					: `${success}. The page couldn't refresh; reload it to see the latest.`,
			);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : "Request failed");
			return false;
		} finally {
			setBusy(false);
		}
	}
	// The URL dialog checks the address inline and shows server messages next to the field.
	const [connectionError, setConnectionError] = useScopedState(localScope, "");
	/** The address already warned about as a duplicate; submitting it again adds it anyway. */
	const [duplicateUrl, setDuplicateUrl] = useScopedState(localScope, "");
	/** What the check found; the field must still hold its address to be confirmed. */
	const [checkedAddress, setCheckedAddress] =
		useScopedState<ConnectionPreview | null>(localScope, null);
	const [addressValue, setAddressValue] = useScopedState(localScope, "");
	/** One idempotency key per dialog: a retry replays the connection it already created. */
	const [connectionRequestId, setConnectionRequestId] = useState(() =>
		crypto.randomUUID(),
	);
	const addressConfirmed =
		!!checkedAddress &&
		readServerAddress(addressValue).url === checkedAddress.url;
	/** The connection just added from the URL dialog; the list highlights it until dismissed. */
	const [added, setAdded] = useState("");
	/** The address as entered, to say when Toolstile saved a different one. */
	const [addedAddress, setAddedAddress] = useState("");
	/** The highlighted connection came back from browser sign-in, not the URL dialog. */
	const [addedSignedIn, setAddedSignedIn] = useState(false);
	useEffect(() => {
		if (section !== "connections") setAdded("");
	}, [section]);
	const addedConnection = data.connections.find(({ id }) => id === added);
	/** The connection a new agent's access should open on: the one just added, else the newest Toolstile can reach. */
	function accessTargetConnection() {
		const usable = data.connections.filter(
			(c) => !connectionUnreachable(connectionStatus(c.status, checks[c.id])),
		);
		if (addedConnection && usable.includes(addedConnection))
			return addedConnection.id;
		return (usable.at(-1) ?? data.connections[0])?.id;
	}
	/** Bumped whenever the URL dialog closes, so a sign-in started from it cannot leave afterwards. */
	const connectionDialog = useRef(0);
	useEffect(
		() => () => {
			connectionDialog.current += 1;
		},
		[],
	);
	useEffect(() => {
		if (modal === "connection") return;
		connectionDialog.current += 1;
		setConnectionError("");
		setDuplicateUrl("");
		setCheckedAddress(null);
		setAddressValue("");
		setConnectionRequestId(crypto.randomUUID());
	}, [
		modal,
		setConnectionError,
		setDuplicateUrl,
		setCheckedAddress,
		setAddressValue,
	]);
	async function addConnection(form: HTMLFormElement) {
		if (pending || activeScope.current !== generation) return;
		const dialog = connectionDialog.current;
		const fields = new FormData(form);
		const field = form.elements.namedItem("url");
		const address = readServerAddress(String(fields.get("url") ?? ""));
		// Show the trimmed address, with https:// added where it was missing.
		if (field instanceof HTMLInputElement && !address.error)
			field.value = address.url;
		setError("");
		if (address.error) {
			setConnectionError(address.error);
			if (field instanceof HTMLInputElement) field.focus();
			return;
		}
		setBusy(true);
		setConnectionError("");
		let leaving = false;
		try {
			// First check the address; the person then confirms the address Toolstile found.
			if (!checkedAddress || checkedAddress.url !== address.url) {
				const found = await connectionRequests.previewConnection({
					url: address.url,
				});
				if (activeScope.current !== generation) return;
				setCheckedAddress(found);
				setAddressValue(found.url);
				if (field instanceof HTMLInputElement) field.value = found.url;
				return;
			}
			const confirmed = checkedAddress;
			const duplicates = data.connections.filter((connection) =>
				sameServerAddress(connection.url, confirmed.url),
			);
			if (duplicates.length && duplicateUrl !== confirmed.url) {
				setDuplicateUrl(confirmed.url);
				return;
			}
			const typedLabel = String(fields.get("label") ?? "").trim();
			// A second connection to the same server gets a numbered name so the rows differ.
			const label =
				typedLabel ||
				(duplicates.length
					? `${duplicates[0].label.slice(0, 90)} (${duplicates.length + 1})`
					: "");
			const transport = fields.get("transport");
			const authentication = fields.get("authentication");
			const bearer = String(fields.get("bearer") ?? "").trim();
			const result = await connectionRequests.connectConnector({
				requestId: connectionRequestId,
				url: confirmed.url,
				...(label ? { label } : {}),
				// Choices under Advanced options win over what the check found.
				transport:
					transport === "http" || transport === "sse"
						? transport
						: confirmed.transport,
				authentication:
					authentication === "headers" || authentication === "oauth"
						? authentication
						: bearer
							? "headers"
							: confirmed.authentication,
				...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
			});
			if (activeScope.current !== generation) return;
			if (result.authentication === "oauth") {
				// Straight to the provider; the sign-in dialog is the fallback that shows why not.
				const started = await leaveForSignIn(
					() => api.startConnectionOAuth({ id: result.id }),
					() =>
						activeScope.current === generation &&
						connectionDialog.current === dialog,
				);
				if (started === "left") {
					// Busy until the browser leaves. Back from the provider restores this page from the
					// cache: the connection exists, so show it in the list rather than offer to add it again.
					leaving = true;
					window.addEventListener(
						"pageshow",
						(event) => {
							if (!event.persisted) return;
							setBusy(false);
							if (activeScope.current !== generation) return;
							onDialogChange(null);
							void reload();
						},
						{ once: true },
					);
					return;
				}
				if (started === "stale") {
					// The dialog closed while sign-in was starting; the connection exists, so list it.
					if (activeScope.current === generation) void reload();
					return;
				}
				onDialogChange("upstream-oauth", { connectionId: result.id });
				await reload();
				return;
			}
			await reload();
			if (activeScope.current !== generation) return;
			// Show the new row in the list instead of leaving the user on the catalog.
			setAdded(result.id);
			setAddedAddress(confirmed.url);
			setAddedSignedIn(false);
			onDialogChange(null);
			onNavigate("connections");
		} catch (e) {
			if (activeScope.current !== generation) return;
			setConnectionError(
				specificMessage(e) ??
					"Toolstile could not add this MCP connection. Check the address and try again.",
			);
		} finally {
			if (!leaving) setBusy(false);
		}
	}
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (modal === "connection") return addConnection(event.currentTarget);
		const form = new FormData(event.currentTarget);
		if (modal === "agent") {
			const errors = tokenFieldErrors(form);
			setTokenErrors(errors);
			if (errors.label || errors.deviceName) {
				event.currentTarget
					.querySelector<HTMLElement>('[aria-invalid="true"]')
					?.focus();
				return;
			}
		}
		await run(async () => {
			if (modal === "agent") {
				let deviceId = String(form.get("deviceId") ?? "");
				const createdDevice = !deviceId;
				if (createdDevice)
					deviceId = (
						await api.addDevice({
							label: String(form.get("deviceName") ?? "").trim() || "My device",
						})
					).id;
				try {
					const result = await api.addAgent({
						label: String(form.get("label") ?? "").trim(),
						deviceId,
						expiresInDays:
							form.get("expiry") === "never"
								? null
								: Number(form.get("expiry")),
					});
					setTokenAgentId(result.id);
					setToken(result.token);
				} catch (e) {
					// Remove the device made for this attempt so a rejected name leaves nothing behind.
					if (createdDevice)
						await api
							.revokeDevice({ id: deviceId })
							.catch(() => reload().catch(() => undefined));
					throw e;
				}
			}
			onDialogChange(null);
		});
	}
	// Server catalogs load on demand. The last one is kept in this browser and shown at once; a
	// live check runs on Refresh or when nothing is stored yet.
	const [catalogs, setCatalogs] = useScopedState<Record<string, CatalogState>>(
		data.user.email,
		{},
	);
	/** The latest tool check made in this browser per connection; it is newer than the stored status. */
	const [checks, setChecks] = useScopedState<
		Record<string, "passed" | "failed">
	>(data.user.email, {});
	const catalogRequests = useRef(new Set<string>());
	const refusedAutomatic = useRef(new Set<string>());
	// A change in what the snapshot says about checking tools (for example a new role) lets
	// automatic loads try again.
	const toolPermission = useRef(new Map<string, boolean | undefined>());
	useEffect(() => {
		for (const { id, canCheckTools } of data.connections) {
			if (
				toolPermission.current.has(id) &&
				toolPermission.current.get(id) !== canCheckTools
			)
				refusedAutomatic.current.delete(id);
			toolPermission.current.set(id, canCheckTools);
		}
	}, [data.connections]);
	const shownCatalogs = useRef(catalogs);
	shownCatalogs.current = catalogs;
	const catalogScope = data.user.email;
	const connectionUrls = useRef(new Map<string, string>());
	connectionUrls.current = new Map(
		data.connections.map((connection) => [connection.id, connection.url]),
	);
	// Stored catalogs also fill the connection list's tool counts without asking the servers.
	useEffect(() => {
		setCatalogs((previous) => {
			let next = previous;
			for (const connection of data.connections) {
				if (previous[connection.id]) continue;
				const cached = readCatalogCache(
					catalogScope,
					connection.id,
					connection.url,
				);
				if (!cached) continue;
				next = {
					...next,
					[connection.id]: { status: "ready", ...cached },
				};
			}
			return next;
		});
	}, [data.connections, catalogScope, setCatalogs]);
	/**
	 * Loads a connection's tools, from this browser's cache unless `refresh`. An `automatic` load
	 * (not asked for by the person) that is refused for lack of permission is skipped quietly: it
	 * says nothing about the server, so it never marks the check failed.
	 */
	const loadCatalog = useCallback(
		(id: string, refresh = false, automatic = false) => {
			if (catalogRequests.current.has(id)) return;
			// Once refused, automatic loads stop asking; the person can still ask.
			if (automatic && refusedAutomatic.current.has(id)) return;
			const url = connectionUrls.current.get(id) ?? "";
			const cached = refresh
				? undefined
				: readCatalogCache(catalogScope, id, url);
			if (cached) {
				setCatalogs((previous) => ({
					...previous,
					[id]: { status: "ready", ...cached },
				}));
				return;
			}
			catalogRequests.current.add(id);
			const prior = shownCatalogs.current[id];
			setCatalogs((previous) => ({
				...previous,
				[id]: { status: "loading", data: previous[id]?.data },
			}));
			api
				.verify({ id })
				.then((catalog) => {
					const checkedAt = new Date().toISOString();
					writeCatalogCache(catalogScope, id, url, catalog, checkedAt);
					setCatalogs((previous) => ({
						...previous,
						[id]: { status: "ready", data: catalog, checkedAt },
					}));
					setChecks((previous) => ({ ...previous, [id]: "passed" }));
				})
				.catch((e: unknown) => {
					if (automatic && authorizationRefused(e)) {
						refusedAutomatic.current.add(id);
						// Put back what was shown before this load. With nothing to put back, settle on a
						// message (not "loading", which would wait forever); the status badge is untouched
						// and Try again still asks the server.
						setCatalogs((previous) => ({
							...previous,
							[id]: prior ?? {
								status: "error",
								message:
									"You do not have permission to load the tools of this MCP connection.",
							},
						}));
						return;
					}
					setChecks((previous) => ({ ...previous, [id]: "failed" }));
					setCatalogs((previous) => ({
						...previous,
						[id]: {
							status: "error",
							message:
								e instanceof Error ? e.message : "The server did not respond.",
							data: previous[id]?.data,
						},
					}));
				})
				.finally(() => {
					catalogRequests.current.delete(id);
					// Verification also refreshes the connection's status badge.
					reload().catch(() => undefined);
				});
		},
		[api, reload, setCatalogs, setChecks, catalogScope],
	);
	// The host passes a fresh callback each render; holding it keeps one notice per status.
	const oauthSeen = useRef(false);
	const consumeOAuthStatus = useRef(onOAuthStatusConsumed);
	consumeOAuthStatus.current = onOAuthStatusConsumed;
	useEffect(() => {
		if (!oauthStatus) {
			oauthSeen.current = false;
			return;
		}
		// Wait for the current snapshot, which has the signed-in connection.
		if (oauthSeen.current || pending) return;
		oauthSeen.current = true;
		const signedIn =
			oauthStatus === "connected" && oauthConnectionId
				? data.connections.find(({ id }) => id === oauthConnectionId)
				: undefined;
		if (signedIn) {
			// The list highlights it with its next step, and its tools load once.
			setAdded(signedIn.id);
			setAddedAddress("");
			setAddedSignedIn(true);
			if (signedIn.canCheckTools !== false)
				loadCatalog(signedIn.id, true, true);
		} else
			setNotice(
				oauthStatus === "connected"
					? "MCP account signed in"
					: "MCP sign-in did not complete. Reopen sign-in to try again.",
				oauthStatus === "failed" ? "error" : "success",
			);
		consumeOAuthStatus.current?.();
	}, [
		oauthStatus,
		oauthConnectionId,
		pending,
		data.connections,
		loadCatalog,
		setNotice,
	]);
	/**
	 * Connections in the current snapshot. One that appears later in this session (added by
	 * URL, from the catalog or by another tab) loads its tools once, as soon as Toolstile can
	 * reach it: a new connection that first waits for approval or sign-in stays `waiting` until
	 * then. The connections already listed do not load, so a page load asks no server.
	 */
	const knownConnections = useRef<{
		email: string;
		seen: Set<string>;
		waiting: Set<string>;
	} | null>(null);
	useEffect(() => {
		// A workspace switch shows the old snapshot while pending; start again from the new one.
		if (pending) {
			knownConnections.current = null;
			return;
		}
		const ids = data.connections.map(({ id }) => id);
		const known = knownConnections.current;
		if (known?.email !== data.user.email) {
			knownConnections.current = {
				email: data.user.email,
				seen: new Set(ids),
				waiting: new Set(),
			};
			return;
		}
		for (const id of ids)
			if (!known.seen.has(id)) {
				known.seen.add(id);
				known.waiting.add(id);
			}
		for (const connection of data.connections)
			if (
				known.waiting.has(connection.id) &&
				toolsLoadable(connection.status)
			) {
				known.waiting.delete(connection.id);
				// Members who may not check tools see them only after someone who may.
				if (connection.canCheckTools !== false)
					loadCatalog(connection.id, false, true);
			}
		// A removed connection stops waiting.
		for (const id of known.waiting)
			if (!ids.includes(id)) known.waiting.delete(id);
	}, [data.connections, data.user.email, pending, loadCatalog]);
	/** Unsaved access edits; leaving the server or page asks first. */
	const [accessDirty, setAccessDirty] = useState(false);
	const reportAccessDirty = useCallback(
		(dirty: boolean) => {
			setAccessDirty(dirty);
			accessNavigation?.onDirtyChange(dirty);
		},
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- Depends on the callback itself; the navigation object is recreated each render.
		[accessNavigation?.onDirtyChange],
	);
	const [leaving, setLeaving] = useState<(() => void) | null>(null);
	const guard = useCallback(
		(action: () => void, routerNavigation = true) => {
			if (accessDirty && (!accessNavigation || !routerNavigation))
				setLeaving(() => action);
			else action();
		},
		[accessDirty, accessNavigation],
	);
	const activeDevices = data.devices.filter((device) => !device.revoked);
	const tokenDevice = activeDevices.find(
		(device) => device.id === tokenDeviceId,
	);
	const nav = navigationEntries(extraNavigation);
	const heading = nav.find((n) => n.id === section)?.label ?? "Toolstile";
	const navigationClick =
		(id: string) => (event: { preventDefault(): void }) => {
			if (accessDirty && !accessNavigation) {
				event.preventDefault();
				guard(() => onNavigate(id));
				return;
			}
			setNotice("");
		};
	function navigationLink(entry: (typeof nav)[number]) {
		return renderNavigationLink(
			navigationItem({
				entry,
				section,
				// Only sections with waiting work carry a count.
				count: entry.count || undefined,
				onClick: navigationClick(entry.id),
			}),
		);
	}
	const description =
		descriptions[section] ??
		extraNavigation.find((n) => n.id === section)?.description;
	function verify(connection: Snapshot["connections"][number]) {
		run(async () => {
			const catalog = await api.verify({ id: connection.id }).catch((e) => {
				setChecks((previous) => ({ ...previous, [connection.id]: "failed" }));
				throw new Error(
					specificMessage(e) ??
						`Toolstile could not load the tools of ${connection.label}. Check its address and token, then refresh tools again.`,
				);
			});
			const checkedAt = new Date().toISOString();
			writeCatalogCache(
				catalogScope,
				connection.id,
				connection.url,
				catalog,
				checkedAt,
			);
			setCatalogs((previous) => ({
				...previous,
				[connection.id]: { status: "ready", data: catalog, checkedAt },
			}));
			setChecks((previous) => ({ ...previous, [connection.id]: "passed" }));
		}, "Tools refreshed");
	}
	const shared: DashboardContextValue = {
		data,
		api,
		reload,
		busy,
		run,
		setNotice,
		onNavigate,
		onDialogChange,
		openConnectAgent: () => setConnectOpen(true),
		createToken,
		confirm: setConfirming,
		onBrowseConnectors,
		catalogs,
		checks,
		loadCatalog,
		verify,
		added,
		addedAddress,
		addedSignedIn,
		// Only the URL dialog records an entered address, and only the sign-in landing is a
		// sign-in; other adds, such as the catalog's, clear both.
		setAdded: (id: string) => {
			setAdded(id);
			setAddedAddress("");
			setAddedSignedIn(false);
		},
		renaming,
		setRenaming,
		rename,
		finishRename,
		accessView,
		onAccessViewChange,
		renderAccessLink,
		everyoneAccess,
		loadStarters,
		reportAccessDirty,
		connectionAccessSummary,
		pagePending: Boolean(pending),
		activity,
	};
	const page = (
		<DashboardContext.Provider value={shared}>
			{children}
		</DashboardContext.Provider>
	);
	return (
		<>
			<DashboardFrame
				status={pending}
				pagePending={Boolean(pending)}
				home={renderHomeLink}
				account={
					<Fragment key={scopeKey}>
						{renderAccountMenu({
							name: data.user.name,
							email: data.user.email,
							links: {
								docs: links?.docs ?? defaultDashboardLinks.docs,
								help: links?.help ?? defaultDashboardLinks.help,
							},
							onSettings: () =>
								guard(() => {
									setNotice("");
									onNavigate("settings");
								}),
							onSignOut: () => guard(onSignOut, false),
						})}
					</Fragment>
				}
				navigation={
					<MainNavigation
						ref={navigationRef}
						scrollable={navigationOverflows}
						groups={navigationGroups}
						entries={nav}
						renderItem={(entry) => navigationLink(entry)}
					/>
				}
				bottom={
					<>
						{sidebarFooter ? (
							<div
								inert={Boolean(pending)}
								{...stylex.props(styles.sidebarFooter)}
							>
								{sidebarFooter}
							</div>
						) : null}
						<SidebarLinks
							links={links}
							trailing={sidebarTrailing}
							settings={renderNavigationLink(
								navigationIconItem({
									entry: nav.find((n) => n.id === "settings") ?? nav[0],
									section,
									onClick: navigationClick("settings"),
								}),
							)}
						/>
					</>
				}
			>
				{/* Settings subpages bring their own column, heading and spacing (SettingsLayout). */}
				{section === "settings" ? (
					page
				) : (
					<div
						{...stylex.props(
							styles.content,
							section === "access" && styles.contentFill,
						)}
					>
						<PageHeader
							title={heading}
							description={description}
							actions={
								section === "connections" && !browsingCatalog ? (
									<button
										type="button"
										{...stylex.props(controls.button, controls.primary)}
										onClick={
											onBrowseConnectors ?? (() => onDialogChange("connection"))
										}
									>
										<PlusIcon />
										Add an MCP connection
									</button>
								) : section === "devices" ? (
									<button
										type="button"
										{...stylex.props(controls.button, controls.primary)}
										onClick={() => setConnectOpen(true)}
									>
										<PlusIcon />
										Connect an agent
									</button>
								) : undefined
							}
						/>
						{(pageError || error) && (
							<div {...stylex.props(styles.pageNotice)}>
								<Notice tone="error">
									<div {...stylex.props(styles.noticeRow)}>
										<span {...stylex.props(styles.noticeText)}>
											{pageError || error}
										</span>
										{pageError ? null : (
											<button
												type="button"
												aria-label="Dismiss error"
												{...stylex.props(
													controls.button,
													controls.quiet,
													controls.small,
													controls.iconOnly,
													styles.noticeDismiss,
												)}
												onClick={() => setError("")}
											>
												<XIcon size={16} />
											</button>
										)}
									</div>
								</Notice>
							</div>
						)}
						{page}
					</div>
				)}
			</DashboardFrame>
			{/* Dialogs portal to the document body; on-demand ones load when first opened. */}
			{modal === "upstream-oauth" ? (
				<Suspense fallback={null}>
					<UpstreamSignIn
						connection={data.connections.find(
							(c) => c.id === selectedConnectionId,
						)}
						api={api}
						onClose={() => onDialogChange(null)}
					/>
				</Suspense>
			) : null}
			{modal === "test-tool" ? (
				<Suspense fallback={null}>
					<ToolTest
						key={`${selectedConnectionId}:${testAgentId}`}
						connection={data.connections.find(
							(c) => c.id === selectedConnectionId,
						)}
						agents={data.agents}
						agentId={testAgentId}
						toolName={selectedToolName}
						api={api}
						reload={reload}
						onClose={() => onDialogChange(null)}
						onSelect={(agentId, toolName) =>
							onDialogChange("test-tool", {
								connectionId: selectedConnectionId,
								agentId,
								toolName,
							})
						}
					/>
				</Suspense>
			) : null}
			{(leaving || accessNavigation?.blocked) && (
				<ConfirmDialog
					title="Discard unsaved access changes?"
					body="Your access changes have not been saved. Leaving now discards them."
					confirmLabel="Discard changes"
					onCancel={() => {
						setLeaving(null);
						accessNavigation?.blocked?.reset();
					}}
					onConfirm={() => {
						setLeaving(null);
						setAccessDirty(false);
						if (accessNavigation?.blocked) accessNavigation.blocked.proceed();
						else {
							accessNavigation?.onDirtyChange(false);
							leaving?.();
						}
					}}
				/>
			)}
			{confirming && (
				<ConfirmDialog
					title={confirming.title}
					body={confirming.body}
					confirmLabel={confirming.confirmLabel}
					busy={busy}
					onCancel={() => setConfirming(null)}
					onConfirm={async () => {
						await run(confirming.work, confirming.success);
						// Close either way so the page notice or error is visible.
						setConfirming(null);
					}}
				/>
			)}
			{connectOpen ? (
				<Suspense fallback={null}>
					<ConnectAgentDialog
						endpoint={endpoint ?? `${location.origin}/mcp`}
						agents={data.agents}
						reload={reload}
						computerSetup={computerSetup}
						onClose={() => setConnectOpen(false)}
						onCreateToken={() => createToken()}
						onGrantAccess={(agentId) => {
							setConnectOpen(false);
							onAccessViewChange({ server: undefined }, false, agentId);
						}}
					/>
				</Suspense>
			) : null}
			{(modal === "connection" || modal === "agent") && (
				<ModalFrame
					title={
						modal === "connection"
							? "Add an MCP connection"
							: "Create an agent token"
					}
					description={
						modal === "connection"
							? "Paste the server's address. Toolstile checks it, then you confirm the address to save."
							: "For an AI app or script that cannot sign in through a browser."
					}
					width="md"
					onClose={() => onDialogChange(null)}
				>
					<form key={modal} onSubmit={submit}>
						{modal === "connection" && (
							<>
								<label {...stylex.props(controls.label, local.firstField)}>
									MCP server URL
									{/* Checked in addConnection, so messages appear inline, not as browser bubbles. */}
									<input
										{...stylex.props(controls.input)}
										name="url"
										type="text"
										inputMode="url"
										autoComplete="off"
										autoCapitalize="off"
										spellCheck={false}
										data-autofocus
										placeholder="https://example.com/mcp"
										aria-invalid={connectionError ? true : undefined}
										aria-describedby={
											connectionError
												? "connection-url-error"
												: duplicateUrl
													? "connection-url-duplicate"
													: undefined
										}
										onChange={(event) => {
											setAddressValue(event.target.value);
											setConnectionError("");
											setDuplicateUrl("");
											setError("");
										}}
									/>
									{connectionError ? (
										<span
											id="connection-url-error"
											role="alert"
											{...stylex.props(local.fieldMessage, controls.error)}
										>
											{connectionError}
										</span>
									) : null}
								</label>
								{addressConfirmed && checkedAddress && !duplicateUrl ? (
									<ConnectionCheckNote preview={checkedAddress} />
								) : null}
								{duplicateUrl ? (
									<div id="connection-url-duplicate" role="status">
										<Notice tone="warning">
											You already have an MCP connection to this address. Add it
											again only to use a different account or token. The new
											one gets a number after its name, or you can enter a name
											under Advanced options.
										</Notice>
									</div>
								) : null}
								<Disclosure summary="Advanced options">
									<label {...stylex.props(controls.label)}>
										<span>
											Name{" "}
											<span {...stylex.props(controls.optional)}>optional</span>
										</span>
										<input
											{...stylex.props(controls.input)}
											name="label"
											maxLength={100}
											placeholder="Detected from the server"
										/>
									</label>
									<label {...stylex.props(controls.label)}>
										<span>
											Bearer token{" "}
											<span {...stylex.props(controls.optional)}>optional</span>
										</span>
										<input
											{...stylex.props(controls.input)}
											name="bearer"
											type="password"
											autoComplete="off"
											maxLength={4096}
											aria-describedby="connection-bearer-hint"
											data-ph-no-capture
										/>
										<span
											id="connection-bearer-hint"
											{...stylex.props(local.fieldMessage, local.hint)}
										>
											A password-like key that some servers give you. Leave it
											empty if the server did not give you one.
										</span>
									</label>
									<label
										{...stylex.props(controls.label)}
										htmlFor="connection-transport"
									>
										Transport
										<SelectField
											id="connection-transport"
											name="transport"
											aria-label="Transport"
											defaultValue="auto"
											items={[
												{ value: "auto", label: "Detect automatically" },
												{ value: "http", label: "Streamable HTTP" },
												{ value: "sse", label: "Legacy HTTP + SSE" },
											]}
										/>
										<span {...stylex.props(local.fieldMessage, local.hint)}>
											How Toolstile talks to the server. Change it only if the
											server's instructions name one.
										</span>
									</label>
									<label
										{...stylex.props(controls.label)}
										htmlFor="connection-authentication"
									>
										Authentication
										<SelectField
											id="connection-authentication"
											name="authentication"
											aria-label="Authentication"
											defaultValue="auto"
											items={[
												{ value: "auto", label: "Detect automatically" },
												{ value: "oauth", label: "Sign in with OAuth" },
												{
													value: "headers",
													label: "Bearer token or none",
												},
											]}
										/>
										<span {...stylex.props(local.fieldMessage, local.hint)}>
											How you prove who you are to the server. Toolstile asks
											you to sign in when the server needs it.
										</span>
									</label>
								</Disclosure>
								<p {...stylex.props(styles.formDescription)}>
									Adding an MCP connection does not grant agent access.
								</p>
							</>
						)}
						{modal === "agent" && (
							<>
								<label {...stylex.props(controls.label, local.firstField)}>
									Agent name
									<input
										{...stylex.props(controls.input)}
										name="label"
										maxLength={100}
										autoComplete="off"
										data-autofocus
										placeholder="Phone assistant"
										aria-invalid={tokenErrors.label ? true : undefined}
										aria-describedby={
											tokenErrors.label ? "agent-label-error" : undefined
										}
										onChange={() =>
											tokenErrors.label &&
											setTokenErrors({ ...tokenErrors, label: undefined })
										}
									/>
									{tokenErrors.label ? (
										<FieldError id="agent-label-error">
											{tokenErrors.label}
										</FieldError>
									) : null}
								</label>
								{tokenDevice ? (
									<>
										<input
											type="hidden"
											name="deviceId"
											value={tokenDevice.id}
										/>
										<p {...stylex.props(styles.formDescription)}>
											Device: <strong>{tokenDevice.label}</strong>
										</p>
									</>
								) : activeDevices.length === 0 ? (
									<label {...stylex.props(controls.label)}>
										Device name
										<input
											{...stylex.props(controls.input)}
											name="deviceName"
											maxLength={100}
											autoComplete="off"
											defaultValue="My device"
											aria-invalid={tokenErrors.deviceName ? true : undefined}
											aria-describedby={
												tokenErrors.deviceName
													? "agent-device-error"
													: undefined
											}
											onChange={() =>
												tokenErrors.deviceName &&
												setTokenErrors({
													...tokenErrors,
													deviceName: undefined,
												})
											}
										/>
										{tokenErrors.deviceName ? (
											<FieldError id="agent-device-error">
												{tokenErrors.deviceName}
											</FieldError>
										) : null}
									</label>
								) : activeDevices.length === 1 ? (
									<input
										type="hidden"
										name="deviceId"
										value={activeDevices[0].id}
									/>
								) : (
									<label
										{...stylex.props(controls.label)}
										htmlFor="agent-device"
									>
										Device
										<SelectField
											id="agent-device"
											name="deviceId"
											aria-label="Device"
											required
											defaultValue={activeDevices[0].id}
											items={activeDevices.map((device) => ({
												value: device.id,
												label: device.label,
											}))}
										/>
									</label>
								)}
								<label {...stylex.props(controls.label)} htmlFor="agent-expiry">
									Token expiry
									<SelectField
										id="agent-expiry"
										name="expiry"
										aria-label="Token expiry"
										defaultValue="90"
										items={[
											{ value: "30", label: "30 days" },
											{ value: "90", label: "90 days" },
											{ value: "365", label: "1 year" },
											{ value: "never", label: "Never" },
										]}
									/>
								</label>
								<p {...stylex.props(styles.formDescription)}>
									New agents start without MCP access. Configure their
									permissions after connecting.
								</p>
							</>
						)}
						{error && (
							<p role="alert" {...stylex.props(controls.error)}>
								{error}
							</p>
						)}
						<footer {...stylex.props(styles.modalActions)}>
							<button
								{...stylex.props(controls.button)}
								type="button"
								onClick={() => onDialogChange(null)}
							>
								Cancel
							</button>
							<button
								type="submit"
								{...stylex.props(controls.button, controls.primary)}
								disabled={busy}
							>
								{busy
									? modal === "connection" && !addressConfirmed
										? "Checking…"
										: "Saving…"
									: modal === "connection"
										? !addressConfirmed
											? checkedAddress
												? "Check address"
												: "Continue"
											: duplicateUrl
												? "Add anyway"
												: "Add connection"
										: "Create token"}
							</button>
						</footer>
					</form>
				</ModalFrame>
			)}
			{token && (
				<ModalFrame
					title="Your agent token"
					description="Copy this token now. It will not be shown again."
					width="md"
					onClose={() => setToken("")}
				>
					<div {...stylex.props(local.tokenBody)}>
						<CopyValue
							value={token}
							copyLabel="Copy token"
							autoFocus
							onCopied={() => setNotice("Token copied")}
							onCopyFailed={() =>
								setError("Select and copy the token manually")
							}
						/>
						<div {...stylex.props(local.tokenRow, local.configHeader)}>
							<h3 {...stylex.props(local.subheading)}>Agent configuration</h3>
							<button
								{...stylex.props(controls.button, controls.small)}
								type="button"
								onClick={() =>
									navigator.clipboard
										.writeText(tokenConfig(endpoint, token))
										.then(() => setNotice("Configuration copied"))
										.catch(() =>
											setError("Select and copy the configuration manually"),
										)
								}
							>
								<CopyIcon size={16} aria-hidden="true" />
								Copy configuration
							</button>
						</div>
						<pre {...stylex.props(controls.pre, local.pre)}>
							{tokenConfig(endpoint, token)}
						</pre>
						<p {...stylex.props(local.note)}>
							Paste this into your app’s MCP settings, or have your script send
							the token in an Authorization: Bearer header. The agent cannot use
							any tools until you give it access.
						</p>
					</div>
					<footer {...stylex.props(styles.modalActions, local.cardFooter)}>
						<button
							type="button"
							{...stylex.props(controls.button, controls.primary)}
							onClick={() => {
								setToken("");
								const server = accessTargetConnection();
								if (server)
									onAccessViewChange(
										{ server, agent: tokenAgentId || undefined },
										false,
										tokenAgentId || undefined,
									);
								else onNavigate("access");
							}}
						>
							Configure access
						</button>
					</footer>
				</ModalFrame>
			)}
		</>
	);
}

/** Remote MCP configuration that sends an agent token; it contains the secret. */
function tokenConfig(endpoint: string | undefined, token: string) {
	return JSON.stringify(
		{
			mcpServers: {
				toolstile: {
					url: endpoint ?? `${location.origin}/mcp`,
					headers: { Authorization: `Bearer ${token}` },
				},
			},
		},
		null,
		2,
	);
}
type TokenFieldErrors = { label?: string; deviceName?: string };
/** Names are trimmed and 1–100 characters, matching the server. */
// Matches the server's name rule (control and text-direction characters are rejected).
const hiddenNameCharacters = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
function tokenFieldErrors(form: FormData): TokenFieldErrors {
	const check = (value: FormDataEntryValue | null, what: string) => {
		if (value === null) return undefined;
		const name = String(value).trim();
		if (!name) return `Enter a name for this ${what}.`;
		if (name.length > 100)
			return `Use 100 characters or fewer for the ${what} name.`;
		if (hiddenNameCharacters.test(name))
			return `Remove line breaks and invisible or text-direction characters from the ${what} name.`;
		return undefined;
	};
	return {
		label: check(form.get("label") ?? "", "agent"),
		deviceName: check(form.get("deviceName"), "device"),
	};
}
function FieldError({ id, children }: { id: string; children: ReactNode }) {
	return (
		<span id={id} {...stylex.props(local.fieldError)}>
			<WarningCircleIcon
				size={16}
				weight="fill"
				aria-hidden="true"
				{...stylex.props(local.fieldErrorIcon)}
			/>
			{children}
		</span>
	);
}
const local = stylex.create({
	fieldMessage: {
		fontWeight: 400,
		fontSize: text.meta,
		lineHeight: text.metaLeading,
	},
	hint: { color: colors.muted },
	firstField: { marginTop: 0 },
	tokenBody: { display: "grid", gap: space.s3, minWidth: 0 },
	tokenRow: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: space.s2,
		minWidth: 0,
	},
	subheading: {
		margin: 0,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		fontWeight: 600,
	},
	// The configuration wraps instead of scrolling sideways on narrow screens.
	pre: {
		margin: 0,
		padding: space.s3,
		lineHeight: typeScale.leading13,
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere",
	},
	configHeader: { justifyContent: "space-between" },
	fieldError: {
		display: "flex",
		alignItems: "flex-start",
		gap: 6,
		color: colors.bad,
		fontSize: text.body,
		fontWeight: 400,
		lineHeight: typeScale.leading13,
	},
	fieldErrorIcon: { flexShrink: 0, marginTop: 1 },
	note: {
		margin: 0,
		color: colors.muted,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	// The card's gap already separates the footer from the body.
	cardFooter: { marginTop: 0 },
});
