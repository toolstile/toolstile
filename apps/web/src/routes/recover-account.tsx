import { createFileRoute, redirect } from "@tanstack/react-router";
import {
	accountAuthHref,
	accountAuthSearch,
} from "@toolstile/ui/account-navigation";
export const Route = createFileRoute("/recover-account")({
	validateSearch: accountAuthSearch,
	beforeLoad: ({ search }) => {
		throw redirect({
			href: accountAuthHref("recover-account", search),
			replace: true,
		});
	},
});
