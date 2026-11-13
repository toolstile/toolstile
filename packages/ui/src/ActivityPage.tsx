import { ActivityPanel } from "./ActivityPanel";
import { useDashboard } from "./DashboardContext";

/** The activity page: recent requests through the gateway. */
export function ActivityPage() {
	const { data, api, activity, onNavigate } = useDashboard();
	return (
		<ActivityPanel
			data={data}
			api={api}
			view={activity?.view ?? {}}
			onViewChange={(view, replace) => activity?.onViewChange(view, replace)}
			debug={activity?.debug}
			onNavigate={onNavigate}
		/>
	);
}
