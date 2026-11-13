import { createFileRoute } from "@tanstack/react-router";
import { useDashboardApp } from "../dashboard-context";
import { OperatorPanel } from "../OperatorPanel";
export const Route = createFileRoute("/app/settings/instance")({
	component: Instance,
});
function Instance() {
	const { instanceApi, data } = useDashboardApp();
	return (
		<OperatorPanel api={instanceApi} email={data.user.email} view="instance" />
	);
}
