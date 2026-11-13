import { safeLocalReturnTo } from "@toolstile/ui/account-navigation";
import { discardLegacyDialogSearch } from "./dashboard-local-dialogs";

// One app-owned default makes later navigation changes independent of auth components.
export const dashboardHref = "/app/connections";
const sensitiveParams =
	/^(?:password|code|token|access_token|refresh_token|id_token|client_secret|payload|capturedPayload)$/i;
/** Redirect old page routes only; protocol routes never pass through this helper. */
export function legacyDashboardHref(path: string, search: string, hash = "") {
	const params = new URLSearchParams(discardLegacyDialogSearch(search));
	for (const key of [...params.keys()])
		if (sensitiveParams.test(key)) params.delete(key);
	const target =
		path === "/instance" ? "/app/settings/instance" : `/app${path}`;
	return safeLocalReturnTo(
		`${target}${params.size ? `?${params}` : ""}${hash ? `#${hash.replace(/^#/, "")}` : ""}`,
		dashboardHref,
	);
}
