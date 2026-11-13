import { createFileRoute } from "@tanstack/react-router";
import { ActivityPage } from "@toolstile/ui/activity-page";
export const Route = createFileRoute("/app/activity")({
	component: ActivityPage,
});
