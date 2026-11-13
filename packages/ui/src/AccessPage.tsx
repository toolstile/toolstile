import { PlusIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { AccessManager } from "./AccessManager";
import { controls } from "./Control.styles";
import { useDashboard } from "./DashboardContext";
import { EmptyState } from "./Primitives";

/** The access page: what each agent may use on each MCP connection. */
export function AccessPage() {
	const {
		data,
		api,
		busy,
		run,
		reload,
		setNotice,
		catalogs,
		loadCatalog,
		accessView,
		onAccessViewChange,
		renderAccessLink,
		everyoneAccess,
		loadStarters,
		reportAccessDirty,
		connectionAccessSummary,
		onDialogChange,
		openConnectAgent,
		onNavigate,
	} = useDashboard();
	return data.connections.length &&
		(everyoneAccess || data.agents.some((agent) => !agent.revoked)) ? (
		<AccessManager
			data={data}
			api={api}
			everyone={everyoneAccess}
			view={accessView}
			onViewChange={(view, replace) => {
				setNotice("");
				onAccessViewChange(view, replace);
			}}
			catalogs={catalogs}
			loadCatalog={loadCatalog}
			busy={busy}
			save={run}
			reload={reload}
			renderLink={renderAccessLink}
			onDirtyChange={reportAccessDirty}
			onSignIn={(connectionId) =>
				onDialogChange("upstream-oauth", { connectionId })
			}
			onConnectAgent={openConnectAgent}
			connectionAccessSummary={connectionAccessSummary}
			loadStarters={loadStarters}
		/>
	) : (
		<EmptyState
			icon={ShieldCheckIcon}
			action={
				data.connections.length ? (
					<button
						{...stylex.props(controls.button)}
						type="button"
						onClick={openConnectAgent}
					>
						<PlusIcon />
						Connect an agent
					</button>
				) : (
					<button
						{...stylex.props(controls.button)}
						type="button"
						onClick={() => onNavigate("connections")}
					>
						Go to connections
					</button>
				)
			}
		>
			{data.connections.length
				? "Connect an agent to choose what it may use on each MCP connection"
				: "Add an MCP connection, then choose what each agent may use"}
		</EmptyState>
	);
}
