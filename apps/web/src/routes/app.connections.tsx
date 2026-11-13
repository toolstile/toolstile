import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsPage } from "@toolstile/ui/connections-page";
import { ConnectionsTabs } from "../dashboard-context";
export const Route = createFileRoute("/app/connections")({
	component: Connections,
});
function Connections() {
	return <ConnectionsPage navigation={<ConnectionsTabs browsing={false} />} />;
}
