import { createFileRoute } from "@tanstack/react-router";
import { AccountAuthPage } from "../AccountAuthPage";
export const Route = createFileRoute("/auth/sign-in")({
	head: () => ({ meta: [{ title: "Sign in · Toolstile" }] }),
	component: () => <AccountAuthPage mode="signin" />,
});
