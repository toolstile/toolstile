import { createFileRoute } from "@tanstack/react-router";
import { accountAuthSearch } from "@toolstile/ui/account-navigation";
import { AccountAuthGate } from "../AccountAuthGate";
export const Route = createFileRoute("/auth")({
	validateSearch: accountAuthSearch,
	head: () => ({
		meta: [
			{ name: "referrer", content: "same-origin" },
			{ name: "robots", content: "noindex" },
		],
	}),
	component: AccountAuthGate,
});
