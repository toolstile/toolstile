import { createFileRoute, redirect } from "@tanstack/react-router";
import { accountAuthHref } from "@toolstile/ui/account-navigation";
export const Route = createFileRoute("/auth/")({
	beforeLoad: ({ search }) => {
		throw redirect({ href: accountAuthHref("sign-in", search), replace: true });
	},
});
