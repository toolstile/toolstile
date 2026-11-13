import { createFileRoute } from "@tanstack/react-router";
import { RecoveryPage } from "../RecoveryPage";
export const Route = createFileRoute("/auth/recover-account")({
	head: () => ({ meta: [{ title: "Recover account · Toolstile" }] }),
	component: RecoveryPage,
});
