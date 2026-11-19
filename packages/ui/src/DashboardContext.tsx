import type { ManagementClient } from "@toolstile/api/client";
import type {
	AccessSearch,
	DashboardDialog,
	Snapshot,
} from "@toolstile/api/contract";
import { createContext, type ReactNode, useContext } from "react";
import type {
	CatalogState,
	EveryoneAccess,
	StarterLoader,
} from "./AccessManager";
import type { ActivityView } from "./ActivityPanel";
import type { useToastFeedback } from "./Toast";

/** A destructive action awaiting the in-app confirmation. */
export interface DashboardConfirmation {
	title: string;
	body: string;
	confirmLabel: string;
	success: string;
	work(): Promise<unknown>;
}

/** Router link to the access page for one server. */
export type AccessLinkRenderer = (link: {
	server: string;
	agentId?: string;
	search?: AccessSearch;
	"aria-current"?: "page";
	className: string;
	children: ReactNode;
}) => ReactNode;

/**
 * State the dashboard layout shares with its page routes. `Dashboard` provides it around the
 * page it renders as `children`, so pages render only inside a loaded dashboard.
 */
export interface DashboardContextValue {
	data: Snapshot;
	api: ManagementClient;
	reload(): Promise<void>;
	busy: boolean;
	/** Runs a change, reloads and shows `success`; failures show the page's error notice. */
	run(work: () => Promise<unknown>, success?: string): Promise<boolean>;
	setNotice: ReturnType<typeof useToastFeedback>;
	onNavigate(section: string): void;
	onDialogChange(
		dialog: DashboardDialog | null,
		selection?: { agentId?: string; connectionId?: string; toolName?: string },
	): void;
	/** Opens the Connect an agent dialog. */
	openConnectAgent(): void;
	/** Opens the Create an agent token dialog, for this device when given. */
	createToken(deviceId?: string): void;
	confirm(action: DashboardConfirmation): void;
	onBrowseConnectors?(): void;
	/** Server catalogs loaded in this browser, and the latest tool check per connection. */
	catalogs: Record<string, CatalogState>;
	checks: Record<string, "passed" | "failed">;
	loadCatalog(id: string, refresh?: boolean, automatic?: boolean): void;
	/** Refreshes a connection's tools now, reporting the result as a notice. */
	verify(connection: Snapshot["connections"][number]): void;
	/**
	 * The connection just added (from the URL dialog, the catalog, or back from browser sign-in),
	 * highlighted on the connections list, and the address as entered in the URL dialog (empty
	 * for other adds).
	 */
	added: string;
	addedAddress: string;
	/** `added` came back from the provider's sign-in rather than an add. */
	addedSignedIn: boolean;
	/** Highlights a connection just added elsewhere, such as the catalog. */
	setAdded(id: string): void;
	renaming: { kind: "device" | "agent"; id: string } | null;
	setRenaming(renaming: { kind: "device" | "agent"; id: string } | null): void;
	rename(kind: "device" | "agent", id: string, label: string): Promise<void>;
	/** Ends a rename and returns focus to that row's menu button. */
	finishRename(id: string): void;
	accessView: AccessSearch;
	onAccessViewChange(
		view: AccessSearch,
		replace?: boolean,
		focusAgentId?: string,
	): void;
	renderAccessLink: AccessLinkRenderer;
	everyoneAccess?: EveryoneAccess;
	loadStarters?: StarterLoader;
	reportAccessDirty(dirty: boolean): void;
	connectionAccessSummary(connectionId: string, short?: boolean): string;
	/** The host is still loading the page's scope; `data` and `api` may belong to the last one. */
	pagePending: boolean;
	activity?: {
		view: ActivityView;
		onViewChange(view: ActivityView, replace?: boolean): void;
		debug?: { selectedPayloadId?: string; onSelectPayload(id?: string): void };
	};
}

export const DashboardContext = createContext<DashboardContextValue | null>(
	null,
);

/** The loaded dashboard's shared state, for page routes rendered inside `Dashboard`. */
export function useDashboard() {
	const value = useContext(DashboardContext);
	if (!value) throw new Error("useDashboard must be used inside Dashboard");
	return value;
}
