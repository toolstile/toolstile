import { type ParsedLocation, redirect } from "@tanstack/react-router";
import { AgentAuthorization, authorizationModeHref } from "@toolstile/ui";
import { legacyDashboardHref } from "./account-navigation";

/** `beforeLoad` for a pre-`/app` page path: it redirects to the same page under `/app`. */
export function redirectLegacyDashboard({
	location,
}: {
	location: ParsedLocation;
}): never {
	throw redirect({
		href: legacyDashboardHref(
			location.pathname,
			location.searchStr,
			location.hash,
		),
		replace: true,
	});
}

/** The agent authorization and consent pages differ only by `consent`. */
export function AgentAuthorizationRoute({
	consent,
	authMode,
	push,
}: {
	consent: boolean;
	authMode?: "signin" | "signup";
	push(href: string): void;
}) {
	return (
		<AgentAuthorization
			consent={consent}
			mode={authMode ?? "signin"}
			onModeChange={(mode) =>
				push(authorizationModeHref(window.location, mode))
			}
		/>
	);
}
