import { useSearch } from "@tanstack/react-router";
import { AccountSessionBoundary } from "@toolstile/ui/account-gate";
import {
	accountAuthHref,
	safeLocalReturnTo,
} from "@toolstile/ui/account-navigation";
import { AccountRedirect } from "./AccountRedirect";
import { dashboardHref } from "./account-navigation";
import { useAccountSession } from "./account-session";
export function AccountEntry() {
	const context = useSearch({ from: "/" });
	const session = useAccountSession();
	return (
		<AccountSessionBoundary
			session={session}
			authenticated={
				<AccountRedirect
					href={safeLocalReturnTo(context.returnTo, dashboardHref)}
				/>
			}
		>
			<AccountRedirect href={accountAuthHref("sign-in", context)} />
		</AccountSessionBoundary>
	);
}
