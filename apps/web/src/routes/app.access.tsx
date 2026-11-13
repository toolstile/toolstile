import { createFileRoute } from "@tanstack/react-router";
import { AccessPage } from "@toolstile/ui/access-page";
export const Route = createFileRoute("/app/access")({
	component: AccessPage,
});
