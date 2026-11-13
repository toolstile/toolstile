import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import {
	ConnectorCatalog,
	ConnectorConnectionForm,
	leaveForSignIn,
	refreshOnReturn,
} from "@toolstile/ui/connectors";
import { useDashboard } from "@toolstile/ui/shell";
import {
	ConnectionsTabs,
	connectionsBasePath,
	renderCatalogLink,
	useDashboardApp,
} from "./dashboard-context";

/** The connector catalog under Connections, for both catalog routes. */
export function CatalogPage() {
	const navigate = useNavigate();
	const search = useSearch({ from: "/app" });
	const pathname = useLocation({ select: (location) => location.pathname });
	const {
		data,
		userId,
		isCurrentUser,
		reload,
		connectors,
		instanceApi,
		openDialog,
	} = useDashboardApp();
	const { setAdded } = useDashboard();
	return (
		<>
			<ConnectionsTabs browsing />
			<ConnectorCatalog
				key={userId}
				api={connectors}
				connect={(input) => connectors.connectConnector(input)}
				renderConnectionForm={(options) => (
					<ConnectorConnectionForm key={options.requestId} {...options} />
				)}
				scopeKey={userId}
				connections={data.connections}
				basePath={connectionsBasePath}
				search={search}
				connectorId={pathname.split("/catalog/")[1]}
				renderLink={renderCatalogLink}
				navigate={(to) => navigate({ to, search: {} })}
				onSearch={(next) =>
					navigate({
						to: pathname,
						search: next,
						replace: true,
						resetScroll: false,
					})
				}
				onCustom={() => openDialog("connection")}
				onCreated={async (result, isFormCurrent) => {
					// The form that saved it, and the signed-in user, are still on screen.
					const current = () => isFormCurrent() && isCurrentUser(userId);
					if (result.authentication === "oauth" && current()) {
						// Straight to the provider; the sign-in dialog is the fallback that shows why not.
						const started = await leaveForSignIn(
							() => instanceApi.startConnectionOAuth({ id: result.id }),
							current,
						);
						if (started === "left") {
							// Back from the provider restores this page from the cache with the old list.
							refreshOnReturn(reload);
							return true;
						}
						if (started === "stale") {
							// The form went away, but the connection was saved: show it.
							if (isCurrentUser(userId)) void reload();
							return;
						}
					}
					await reload();
					if (!current()) return;
					if (result.authentication === "oauth")
						openDialog("upstream-oauth", { connectionId: result.id });
					else {
						// The same landing as a URL add: the new row and its next step.
						setAdded(result.id);
						navigate({ to: connectionsBasePath, search: {} });
					}
				}}
			/>
		</>
	);
}
