import type { ReactNode } from "react";
import type { AccountSessionStatus } from "./AccountSession";
import { AuthLoading } from "./AuthLoading";

/** Shared loading/error presentation; applications own redirects and restricted-account actions. */
export function AccountSessionBoundary({
	session,
	authenticated,
	restricted,
	children,
}: {
	session: { status: AccountSessionStatus; retry(): void };
	authenticated: ReactNode;
	restricted?: ReactNode;
	children: ReactNode;
}) {
	if (session.status === "loading") return <AuthLoading />;
	if (session.status === "error")
		return (
			<AuthLoading
				error="Unable to check your session. Try again to continue."
				onRetry={session.retry}
			/>
		);
	if (session.status === "authenticated") return authenticated;
	if (session.status === "restricted" && restricted !== undefined)
		return restricted;
	return children;
}
