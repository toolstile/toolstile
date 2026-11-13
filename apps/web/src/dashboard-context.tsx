import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { Link } from "@tanstack/react-router";
import type { ConnectorClient } from "@toolstile/api/connector-client";
import type { DashboardDialog, Snapshot } from "@toolstile/api/contract";
import { ConnectionsCatalogNavigation } from "@toolstile/ui/connections-navigation";
import type { ConnectorCatalogProps } from "@toolstile/ui/connectors";
import type { DashboardDialogSelection } from "@toolstile/ui/shell";
import { createContext, useContext } from "react";
import type { instanceRouter } from "./server/runtime";

export const createInstanceClient = (url: string) =>
	createORPCClient<RouterClient<typeof instanceRouter>>(new RPCLink({ url }));
export type InstanceClient = ReturnType<typeof createInstanceClient>;

/** What this app's page routes need beyond the shared dashboard state. */
export interface DashboardAppContextValue {
	data: Snapshot;
	userId: string;
	/** False once another user has signed in since `userId` was read. */
	isCurrentUser(userId: string): boolean;
	reload(): Promise<void>;
	instanceApi: InstanceClient;
	connectors: ConnectorClient;
	endpoint: string;
	openDialog(
		modal: DashboardDialog,
		selection?: DashboardDialogSelection,
	): void;
	accountAction?: "recovery" | "delete";
	onAccountAction(action?: "recovery" | "delete"): void;
}

export const DashboardAppContext =
	createContext<DashboardAppContextValue | null>(null);

export function useDashboardApp() {
	const value = useContext(DashboardAppContext);
	if (!value)
		throw new Error("useDashboardApp must be used inside DashboardApp");
	return value;
}

export const connectionsBasePath = "/app/connections";

export const renderCatalogLink = ({
	to,
	...props
}: Parameters<ConnectorCatalogProps["renderLink"]>[0]) => (
	<Link to={to} search={{}} {...props} />
);

/** The Connected / Browse catalog switch above the connections pages. */
export function ConnectionsTabs({ browsing }: { browsing: boolean }) {
	return (
		<ConnectionsCatalogNavigation
			basePath={connectionsBasePath}
			browsing={browsing}
			renderLink={renderCatalogLink}
		/>
	);
}
