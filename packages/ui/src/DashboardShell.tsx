import * as stylex from "@stylexjs/stylex";
import { createClient } from "@toolstile/api/client";
import { createConnectorClient } from "@toolstile/api/connector-client";
import type { AccessSearch, DashboardDialog } from "@toolstile/api/contract";
import { type ComponentProps, Fragment, type ReactNode, useMemo } from "react";
import type { EveryoneAccess } from "./AccessManager";
import type { ActivityView } from "./ActivityPanel";
import { Dashboard } from "./Dashboard";
import { dashboardStyles } from "./Dashboard.styles";
import { type DashboardShellLink, shellDestination } from "./Navigation";
import type { SettingsNavigationGroup } from "./SettingsLayout";
import { SettingsLayout } from "./SettingsLayout";
import { SetupGuide } from "./SetupGuide";

export { dashboardStyles } from "./Dashboard.styles";
// Host pages under Connections, such as the catalog, hand a new connection to the list.
export { useDashboard } from "./DashboardContext";
export { DashboardFrame } from "./DashboardFrame";
export {
	type DashboardLinks,
	type DashboardNavigationGroup,
	type DashboardShellLink,
	defaultNavigationGroups,
	type ExtraNavigationItem,
	MainNavigation,
	type NavigationEntry,
	navigationEntries,
	navigationIconItem,
	navigationItem,
	SidebarLinks,
	shellDestination,
} from "./Navigation";
export {
	type NavigationCountLoaders,
	useNavigationCounts,
	withNavigationCounts,
} from "./navigation-counts";
export { SidebarCompact } from "./SidebarMode";
export { Tooltip } from "./Tooltip";

export interface DashboardDialogSelection {
	agentId?: string;
	connectionId?: string;
	toolName?: string;
}

type DashboardProps = ComponentProps<typeof Dashboard>;
type SetupGuideProps = ComponentProps<typeof SetupGuide>;

/**
 * Same-origin RPC clients. `fallbackOrigin` is used during server rendering; `headers` are sent
 * with every request and recreate the clients when they change. `extra` builds an app-owned
 * client (such as the setup client) against the same URL and headers.
 */
export function useDashboardClients<Extra>({
	fallbackOrigin,
	headers = {},
	extra,
}: {
	fallbackOrigin: string;
	headers?: Record<string, string>;
	extra(url: string, headers: () => Record<string, string>): Extra;
}) {
	const origin =
		typeof location === "undefined" ? fallbackOrigin : location.origin;
	const key = JSON.stringify(headers);
	// Headers are compared by value through `key`.
	return useMemo(() => {
		const url = `${origin}/api/rpc`;
		const sent = JSON.parse(key) as Record<string, string>;
		const send = () => sent;
		return {
			origin,
			endpoint: `${origin}/mcp`,
			api: createClient(url, send),
			connectors: createConnectorClient(url, send),
			extra: extra(url, send),
		};
	}, [origin, key, extra]);
}

export { useLoaded, useScopedState } from "./ScopedState";

/** Settings navigation groups from page labels, in the given group order. */
export function settingsNavigation<Page extends string>(
	pages: Record<Page, { label: string }>,
	groups: readonly (readonly [label: string, ids: readonly Page[]])[],
	basePath = "/app/settings",
): SettingsNavigationGroup[] {
	return groups.map(([label, ids]) => ({
		label,
		items: ids.map((id) => ({
			id,
			label: pages[id].label,
			to: `${basePath}/${id}`,
		})),
	}));
}

/** The settings subpage for `/settings/$page`, when it is one of `pages`. */
export function settingsPageFor<Page extends string>(
	section: string,
	page: string | undefined,
	pages: Record<Page, unknown>,
): Page | undefined {
	return section === "settings" && page && Object.hasOwn(pages, page)
		? (page as Page)
		: undefined;
}

/**
 * `Dashboard` wired the same way in every app: navigation through `destinations`, dashboard
 * dialogs from caller-owned local state, the docked setup guide, the activity view and the
 * settings layout. `children` is the current page route; the core pages come from the
 * `connections-page`, `devices-page`, `access-page` and `activity-page` subpaths. Apps keep
 * their own loading, authorization and private pages.
 */
export function DashboardShell({
	section,
	destinations,
	navigate,
	renderLink,
	dialog,
	setup,
	debug,
	activityView = {},
	onActivityViewChange,
	settings,
	accessView = {},
	everyoneAccess,
	sidebarCard,
	children,
	...dashboard
}: Omit<
	DashboardProps,
	| "onNavigate"
	| "renderNavigationLink"
	| "renderHomeLink"
	| "modal"
	| "selectedConnectionId"
	| "selectedToolName"
	| "testAgentId"
	| "onDialogChange"
	| "sidebarFooter"
	| "accessView"
	| "onAccessViewChange"
	| "renderAccessLink"
	| "everyoneAccess"
	| "activity"
> & {
	/** Route for each navigation id; unknown ids go to `/connections`. */
	destinations: Record<string, string>;
	/**
	 * Navigates to a destination path, applying the app's search-parameter rules. `search` is
	 * the access page view and is cleared on every other page.
	 */
	navigate(
		to: string,
		search?: AccessSearch,
		options?: { replace?: boolean; hash?: string },
	): void;
	renderLink(link: DashboardShellLink): ReactNode;
	dialog: {
		modal?: DashboardDialog | null;
		selection?: DashboardDialogSelection;
		onChange(
			modal: DashboardDialog | null,
			selection?: DashboardDialogSelection,
		): void;
		onClose(): void;
	};
	/** Docked guided setup; omitted until progress has loaded. */
	setup?: Omit<
		SetupGuideProps,
		"variant" | "data" | "reload" | "onDialog" | "onConfigureAccess" | "onDone"
	> | null;
	/** Access page view from validated URL search parameters. */
	accessView?: AccessSearch;
	/** Rules for all of the user's agents, where the host supports them. */
	everyoneAccess?: EveryoneAccess;
	/**
	 * The app's own sidebar card, above the docked setup card and the bottom row. The app decides
	 * when it shows, such as plan usage once setup is out of the way.
	 */
	sidebarCard?: ReactNode;
	/** Debug capture tab on the activity page. */
	debug?: { selectedPayloadId?: string; onSelectPayload(id?: string): void };
	/** Activity page view from validated URL search parameters. */
	activityView?: ActivityView;
	/** Opens the activity page with this view; `replace` is set while typing a search. */
	onActivityViewChange(view: ActivityView, replace?: boolean): void;
	/** Settings navigation around the settings section's page (`children`). */
	settings?: {
		groups: SettingsNavigationGroup[];
		current: string;
		description?: ReactNode;
	};
}) {
	const destination = (id: string) => shellDestination(destinations, id);
	const { modal, selection, onChange, onClose } = dialog;
	const guide = setup ? (
		<SetupGuide
			{...setup}
			variant="docked"
			data={dashboard.data}
			reload={dashboard.reload}
			onDialog={(kind, selection) => {
				if (kind === "connection" && dashboard.onBrowseConnectors)
					dashboard.onBrowseConnectors();
				else onChange(kind, selection);
			}}
			onConfigureAccess={(server, agent) => {
				onClose();
				// Exactly the connection and agent setup uses; nothing else from the access view.
				navigate(destination("access"), agent ? { server, agent } : { server });
			}}
			onDone={onClose}
		/>
	) : null;
	return (
		<Dashboard
			{...dashboard}
			section={section}
			modal={modal ?? null}
			selectedConnectionId={selection?.connectionId}
			selectedToolName={selection?.toolName}
			testAgentId={selection?.agentId}
			onDialogChange={onChange}
			accessView={accessView}
			everyoneAccess={everyoneAccess}
			activity={{
				view: activityView,
				onViewChange: onActivityViewChange,
				debug,
			}}
			onAccessViewChange={(view, replace, focusAgentId) =>
				navigate(destination("access"), view, {
					replace,
					hash: focusAgentId ? `access-agent-${focusAgentId}` : undefined,
				})
			}
			renderAccessLink={({ server, agentId, search, ...props }) =>
				renderLink({
					...props,
					to: destination("access"),
					search: { ...search, server },
					hash: agentId ? `access-agent-${agentId}` : undefined,
					onClick: onClose,
				})
			}
			onNavigate={(id) => {
				onClose();
				navigate(destination(id));
			}}
			renderHomeLink={(props) =>
				renderLink({
					...props,
					to: destination("connections"),
					"aria-label": "Toolstile home",
					onClick: onClose,
				})
			}
			renderNavigationLink={({ id, onClick, ...props }) => (
				<Fragment key={id}>
					{renderLink({
						...props,
						to: destination(id),
						onClick: (event) => {
							onClick(event);
							onClose();
						},
					})}
				</Fragment>
			)}
			sidebarFooter={
				// The app's card sits above the setup card or a paused setup's resume prompt.
				sidebarCard && setup ? (
					<div {...stylex.props(dashboardStyles.sidebarFooterStack)}>
						{sidebarCard}
						{guide}
					</div>
				) : (
					sidebarCard || guide
				)
			}
		>
			{section === "settings" && settings ? (
				<SettingsLayout
					groups={settings.groups}
					current={settings.current}
					description={settings.description}
					renderLink={({ id, ...props }) => (
						<Fragment key={id}>
							{renderLink({ ...props, onClick: onClose })}
						</Fragment>
					)}
				>
					{children}
				</SettingsLayout>
			) : (
				children
			)}
		</Dashboard>
	);
}
