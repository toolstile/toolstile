import { createFileRoute } from "@tanstack/react-router";
import { accountAuthSearch } from "@toolstile/ui/account-navigation";
import { AccountEntry } from "../AccountEntry";
export const Route = createFileRoute("/")({
	validateSearch: accountAuthSearch,
	component: AccountEntry,
});
