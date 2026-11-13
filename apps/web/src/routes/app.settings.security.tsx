import { createFileRoute } from "@tanstack/react-router";
import { AccountPanel } from "../AccountPanel";
import { useDashboardApp } from "../dashboard-context";
export const Route = createFileRoute("/app/settings/security")({
	component: Security,
});
function Security() {
	const { instanceApi, accountAction, onAccountAction } = useDashboardApp();
	return (
		<AccountPanel
			api={instanceApi}
			action={accountAction}
			onSelect={onAccountAction}
		/>
	);
}
