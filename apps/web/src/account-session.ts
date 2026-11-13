import {
	readAccountSession as readSharedSession,
	useAccountSession as useSharedSession,
} from "@toolstile/ui/account-session";

/** Keep the instance's protected procedure and response policy in the application. */
async function checkAccountAccess(signal?: AbortSignal) {
	const response = await fetch("/api/rpc/accountStatus", {
		method: "POST",
		signal,
		credentials: "same-origin",
		cache: "no-store",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	if (response.status === 401 || response.status === 403) return false;
	if (!response.ok) throw new Error("Unable to check your session.");
	return true;
}
export const readAccountSession = (signal?: AbortSignal) =>
	readSharedSession(checkAccountAccess, signal);
export const useAccountSession = () => useSharedSession(checkAccountAccess);
