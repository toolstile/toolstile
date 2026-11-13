import { Outlet, useSearch } from "@tanstack/react-router";
import { AccountSessionBoundary } from "@toolstile/ui/account-gate";
import { safeLocalReturnTo } from "@toolstile/ui/account-navigation";
import { AccountRedirect } from "./AccountRedirect";
import { useAccountSession } from "./account-session";
/** General account pages remain reachable when the application denies account access. */
export function AccountAuthGate() {
	const context = useSearch({ from: "/auth" });
	const session = useAccountSession();
	return (
		<AccountSessionBoundary
			session={session}
			authenticated={
				<AccountRedirect href={safeLocalReturnTo(context.returnTo)} />
			}
		>
			<Outlet />
		</AccountSessionBoundary>
	);
}
