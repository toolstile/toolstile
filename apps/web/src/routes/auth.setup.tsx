import { createFileRoute } from "@tanstack/react-router";
import { SetupAccountPage } from "../SetupAccountPage";
export const Route = createFileRoute("/auth/setup")({
	head: () => ({ meta: [{ title: "Set up Toolstile" }] }),
	component: SetupAccountPage,
});
