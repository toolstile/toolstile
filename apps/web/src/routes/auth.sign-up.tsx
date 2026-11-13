import { createFileRoute } from "@tanstack/react-router";
import { AccountAuthPage } from "../AccountAuthPage";
export const Route = createFileRoute("/auth/sign-up")({
	head: () => ({ meta: [{ title: "Create account · Toolstile" }] }),
	component: () => <AccountAuthPage mode="signup" />,
});
