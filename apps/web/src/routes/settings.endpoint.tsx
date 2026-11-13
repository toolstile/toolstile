import { createFileRoute } from "@tanstack/react-router";
import { redirectLegacyDashboard } from "../route-helpers";
export const Route = createFileRoute("/settings/endpoint")({
	beforeLoad: redirectLegacyDashboard,
});
