import { createFileRoute } from "@tanstack/react-router";
import { EndpointSettings } from "@toolstile/ui";
import { useDashboardApp } from "../dashboard-context";
export const Route = createFileRoute("/app/settings/endpoint")({
	component: Endpoint,
});
function Endpoint() {
	return <EndpointSettings endpoint={useDashboardApp().endpoint} />;
}
