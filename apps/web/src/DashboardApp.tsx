import { ListChecksIcon, UserCheckIcon } from "@phosphor-icons/react";
import {
	Link,
	Navigate,
	useBlocker,
	useLocation,
	useNavigate,
	useSearch,
} from "@tanstack/react-router";
import type {
	AccessSearch,
	DashboardDialog,
	Snapshot,
} from "@toolstile/api/contract";
import {
	connectionAccess,
	connectionAccessLabel,
	UserMenu,
} from "@toolstile/ui";
import { AccountSessionBoundary } from "@toolstile/ui/account-gate";
import {
	accountAuthContext,
	accountAuthHref,
} from "@toolstile/ui/account-navigation";
import { AuthLoading } from "@toolstile/ui/auth-loading";
import { useSetupProgress } from "@toolstile/ui/setup";
import type { SetupState } from "@toolstile/ui/setup-contract";
import {
	type DashboardDialogSelection,
	DashboardShell,
	type DashboardShellLink,
	settingsNavigation,
	settingsPageFor,
	useDashboardClients,
	useNavigationCounts,
	useScopedState,
	withNavigationCounts,
} from "@toolstile/ui/shell";
import { useToastFeedback } from "@toolstile/ui/toast";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccountRedirect } from "./AccountRedirect";
import { useAccountSession } from "./account-session";
import {
	connectionsBasePath,
	createInstanceClient,
	DashboardAppContext,
} from "./dashboard-context";

const destinations = {
	connections: "/app/connections",
	devices: "/app/devices",
	access: "/app/access",
	approvals: "/app/approvals",
	"tool-reviews": "/app/tool-reviews",
	activity: "/app/activity",
	settings: "/app/settings/endpoint",
} as const;
const settingsPages = {
	security: {
		label: "Security",
		description: "Recovery codes, sign-in methods and account deletion",
	},
	endpoint: {
		label: "Endpoint",
		description: "Point your agents' MCP clients at this address",
	},
	instance: {
		label: "Instance",
		description: "Registration, network access, retention and telemetry",
	},
	users: {
		label: "Users",
		description: "Invitations and the people on this instance",
	},
} as const;
type SettingsPage = keyof typeof settingsPages;
const operatorSettingsPages: SettingsPage[] = ["instance", "users"];
const settingsGroups = (operator: boolean) =>
	settingsNavigation(settingsPages, [
		["Account", ["security"]],
		["Gateway", ["endpoint"]],
		// Instance administration is only offered to operators; the server enforces it too.
		...(operator ? [["Instance", operatorSettingsPages] as const] : []),
	]);
type LocalDialogs = {
	modal?: DashboardDialog;
	selection?: DashboardDialogSelection;
	accountAction?: "recovery" | "delete";
};
const extraNavigation = [
	{
		id: "approvals",
		label: "Approvals",
		icon: UserCheckIcon,
		description:
			"Tool calls waiting for your approval, checked before they run",
	},
	{
		id: "tool-reviews",
		label: "Tool reviews",
		icon: ListChecksIcon,
		description:
			"New and changed tools stay hidden from agents until someone accepts them",
	},
];
const navigationGroups = [
	{
		id: "gateway",
		label: "Gateway",
		items: [
			"connections",
			"devices",
			"access",
			"approvals",
			"tool-reviews",
			"activity",
		],
	},
];
// Every navigation states the access view so leaving the access page clears it; the
// approvals and activity views are cleared too and only set by their pages.
const accessSearch = (search?: AccessSearch) => ({
	server: search?.server,
	capability: search?.capability,
	query: search?.query,
	agent: search?.agent,
	status: undefined,
	page: undefined,
	approvalId: undefined,
	connection: undefined,
	tab: undefined,
	outcome: undefined,
	debugPayloadId: undefined,
});

/** The dashboard layout: session and data loading, then the shell around the page in `children`. */
export function DashboardApp({
	section,
	settingsPage,
	children,
}: {
	section: string;
	settingsPage?: string;
	/** The page route's outlet, rendered once the snapshot has loaded. */
	children: ReactNode;
}) {
	const navigate = useNavigate();
	const search = useSearch({ from: "/app" });
	const href = useLocation({ select: (location) => location.href });
	const pathname = useLocation({ select: (location) => location.pathname });
	const session = useAccountSession();
	const [accessDirty, setAccessDirty] = useState(false);
	const firstConnection = useRef<string | undefined>(undefined);
	const accessBlocker = useBlocker({
		shouldBlockFn: ({ current, next }) =>
			accessDirty &&
			(current.pathname !== next.pathname ||
				(("server" in current.search ? current.search.server : undefined) ??
					firstConnection.current) !==
					(("server" in next.search ? next.search.server : undefined) ??
						firstConnection.current)),
		enableBeforeUnload: accessDirty,
		withResolver: true,
	});
	const [loadError, setLoadError] = useScopedState(
		session.userId ?? "anonymous",
		"",
	);
	const page = settingsPageFor(section, settingsPage, settingsPages);
	const [setup, setSetup] = useScopedState<SetupState | null>(
		session.userId ?? "anonymous",
		null,
	);
	const setupProgress = useSetupProgress(setSetup);
	const [loaded, setLoaded] = useState<{
		identity: string;
		data: Snapshot;
	} | null>(null);
	const data = loaded?.identity === session.userId ? loaded.data : null;
	const shownData = useRef(data);
	shownData.current = data;
	const notify = useToastFeedback(session.userId ?? "anonymous");
	firstConnection.current = data?.connections[0]?.id;
	const [loading, setLoading] = useState(true);
	const activeIdentity = useRef(session.userId);
	activeIdentity.current = session.userId;
	const loadRequest = useRef<AbortController | null>(null);
	// Dialogs close on every navigation and when the signed-in user changes.
	const [dialogs, setDialogs] = useScopedState<LocalDialogs>(
		JSON.stringify([href, data?.user.email]),
		{},
	);
	const closeDialogs = () => setDialogs({});
	const {
		api,
		extra: instanceApi,
		connectors,
		endpoint,
	} = useDashboardClients({
		fallbackOrigin: "http://127.0.0.1:4310",
		extra: createInstanceClient,
	});
	async function reload() {
		const identity = session.userId;
		if (!identity || activeIdentity.current !== identity) return;
		loadRequest.current?.abort();
		const request = new AbortController();
		loadRequest.current = request;
		const current = () =>
			!request.signal.aborted && activeIdentity.current === identity;
		setLoadError("");
		const applySetup = setupProgress.reloadStarted();
		try {
			const [snapshot, progress] = await Promise.all([
				api.snapshot(),
				instanceApi.setupStatus(undefined, { signal: request.signal }),
			]);
			if (!current()) return;
			setLoaded({ identity, data: snapshot });
			applySetup(progress);
		} catch (error) {
			if (!current()) return;
			// A failed background refresh keeps the last good snapshot on screen.
			if (shownData.current)
				notify(
					"Unable to refresh the dashboard. Showing the last loaded data; reload the page to try again.",
					"error",
				);
			else {
				setLoaded(null);
				setSetup(null);
				setLoadError("Unable to load your account. Try again to continue.");
			}
			throw error;
		} finally {
			if (current()) setLoading(false);
		}
	}
	function retryLoad() {
		if (!session.userId || activeIdentity.current !== session.userId) return;
		setLoading(true);
		// reload reports its own failure.
		reload().catch(() => undefined);
	}
	// Reload on authenticated user changes, not each render of retryLoad.
	useEffect(() => {
		if (session.status === "authenticated") retryLoad();
		return () => loadRequest.current?.abort();
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- Reload on authenticated user changes, not each render of retryLoad.
	}, [session.status, session.userId]);
	// Waiting approvals and tool changes, shown on their sidebar items; reloaded on navigation.
	const navigationCounts = useNavigationCounts(
		session.status === "authenticated"
			? {
					approvals: () =>
						instanceApi
							.listApprovals({ status: "pending" })
							.then((list) => list.total),
					"tool-reviews": () =>
						instanceApi
							.toolReviewSummary()
							.then((summary) =>
								summary.connections.reduce(
									(total, connection) => total + connection.pending,
									0,
								),
							),
				}
			: {},
		`${session.userId ?? ""}:${pathname}`,
	);
	const navigation = withNavigationCounts(extraNavigation, navigationCounts);
	// Keep the dashboard mounted for navigation after the initial authenticated snapshot.
	const sidebar = {
		section,
		destinations,
		renderLink: ({ to, search, children, ...props }: DashboardShellLink) => (
			<Link
				to={to}
				// Each page starts from its own view; another page's filters never follow.
				search={{
					...accessSearch(search),
					oauth: undefined,
					oauthConnection: undefined,
				}}
				{...props}
			>
				{children}
			</Link>
		),
	};
	if (session.status !== "authenticated")
		return (
			<AccountSessionBoundary session={session} authenticated={null}>
				<AccountRedirect
					href={accountAuthHref("sign-in", accountAuthContext(href))}
				/>
			</AccountSessionBoundary>
		);
	if (!data && (loading || !loadError)) return <AuthLoading />;
	if (!data)
		return (
			<AuthLoading
				error={
					loadError || "Unable to load your account. Try again to continue."
				}
				onRetry={retryLoad}
			/>
		);
	const operatorOnly =
		page !== undefined &&
		operatorSettingsPages.includes(page) &&
		!data.user.operator;
	const browsing =
		pathname === `${connectionsBasePath}/catalog` ||
		pathname.startsWith(`${connectionsBasePath}/catalog/`);
	const userId = session.userId ?? "";
	return (
		<DashboardAppContext.Provider
			value={{
				data,
				userId,
				isCurrentUser: (identity) => activeIdentity.current === identity,
				reload,
				instanceApi,
				connectors,
				endpoint,
				openDialog: (modal, selection) => setDialogs({ modal, selection }),
				accountAction: dialogs.accountAction,
				onAccountAction: (accountAction) => setDialogs({ accountAction }),
			}}
		>
			<DashboardShell
				onBrowseConnectors={() =>
					navigate({ to: `${connectionsBasePath}/catalog`, search: {} })
				}
				browsingCatalog={browsing}
				accessNavigation={{
					onDirtyChange: setAccessDirty,
					blocked:
						accessBlocker.status === "blocked" ? accessBlocker : undefined,
				}}
				scopeKey={pathname}
				{...sidebar}
				data={data}
				connectionAccessSummary={(connectionId, short) =>
					connectionAccessLabel(connectionAccess(data, connectionId), short)
				}
				api={api}
				connectionRequests={connectors}
				reload={reload}
				oauthStatus={search.oauth}
				oauthConnectionId={search.oauthConnection}
				onOAuthStatusConsumed={() =>
					void navigate({
						to: pathname,
						search: (previous) => ({
							...previous,
							oauth: undefined,
							oauthConnection: undefined,
						}),
						replace: true,
						resetScroll: false,
					})
				}
				endpoint={endpoint}
				navigate={(to, access, options) =>
					navigate({
						to,
						replace: options?.replace,
						hash: options?.hash,
						resetScroll: to.endsWith("/access") ? false : !options?.replace,
						search: {
							...accessSearch(access),
							oauth: undefined,
							oauthConnection: undefined,
						},
					})
				}
				accessView={{
					server: search.server,
					capability: search.capability,
					query: search.query,
					agent: search.agent,
				}}
				extraNavigation={navigation}
				navigationGroups={navigationGroups}
				everyoneAccess={instanceApi}
				loadStarters={(connection) => connectors.connectorStarters(connection)}
				dialog={{
					modal: dialogs.modal,
					selection: dialogs.selection,
					onChange: (modal, selection) =>
						setDialogs(modal ? { modal, selection } : {}),
					onClose: closeDialogs,
				}}
				setup={
					setup && {
						state: setup,
						api: instanceApi,
						endpoint,
						onState: setupProgress.onState,
					}
				}
				activityView={{
					tab: search.tab,
					outcome: search.outcome,
					query: search.query,
					page: search.page,
				}}
				onActivityViewChange={(view, replace) =>
					navigate({
						to: "/app/activity",
						replace,
						resetScroll: false,
						search: {
							...accessSearch(),
							...view,
							debugPayloadId:
								view.tab === "debug" ? search.debugPayloadId : undefined,
						},
					})
				}
				debug={{
					selectedPayloadId: search.debugPayloadId,
					onSelectPayload: (debugPayloadId) =>
						navigate({
							to: "/app/activity",
							resetScroll: false,
							search: (previous) => ({ ...previous, debugPayloadId }),
						}),
				}}
				settings={
					page && !operatorOnly
						? {
								groups: settingsGroups(data.user.operator),
								current: page,
								description: settingsPages[page].description,
							}
						: undefined
				}
				renderAccountMenu={(menu) => <UserMenu {...menu} />}
				onSignOut={async () => {
					closeDialogs();
					try {
						const response = await fetch("/api/auth/sign-out", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: "{}",
						});
						if (!response.ok)
							throw new Error(`Sign-out failed: ${response.status}`);
					} catch {
						// Still signed in; say so rather than showing a signed-out screen.
						notify(
							"Unable to sign out. Check your connection and try again.",
							"error",
						);
						return;
					}
					setLoaded(null);
					session.retry();
				}}
			>
				{operatorOnly ? (
					<Navigate to="/app/settings/endpoint" replace />
				) : (
					children
				)}
			</DashboardShell>
		</DashboardAppContext.Provider>
	);
}
