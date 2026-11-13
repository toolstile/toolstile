import { createFileRoute } from "@tanstack/react-router";
import { DevicesPage } from "@toolstile/ui/devices-page";
export const Route = createFileRoute("/app/devices")({
	component: DevicesPage,
});
