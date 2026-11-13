import { useCallback, useEffect, useRef, useState } from "react";

export type AccountSessionStatus =
	| "loading"
	| "authenticated"
	| "anonymous"
	| "restricted"
	| "error";
type AccountAccessCheck = (signal?: AbortSignal) => Promise<boolean>;

type ResolvedSession = {
	status: "authenticated" | "anonymous" | "restricted";
	userId: string | null;
};

/** Session presence alone does not establish permission to open the application. */
async function resolveAccountSession(
	checkAccess: AccountAccessCheck,
	signal?: AbortSignal,
): Promise<ResolvedSession> {
	signal?.throwIfAborted();
	const response = await fetch("/api/auth/get-session", {
		signal,
		credentials: "same-origin",
		cache: "no-store",
	});
	if (!response.ok) throw new Error("Unable to check your session.");
	const result: unknown = await response.json();
	if (result === null) return { status: "anonymous", userId: null };
	if (
		typeof result !== "object" ||
		!("session" in result) ||
		!result.session ||
		typeof result.session !== "object" ||
		!("user" in result) ||
		!result.user ||
		typeof result.user !== "object" ||
		!("id" in result.user) ||
		typeof result.user.id !== "string"
	)
		throw new Error("Unable to check your session.");
	signal?.throwIfAborted();
	const allowed = await checkAccess(signal);
	signal?.throwIfAborted();
	return {
		status: allowed ? "authenticated" : "restricted",
		userId: result.user.id,
	};
}

/** Resolve a session without exposing application-specific access policy. */
export async function readAccountSession(
	checkAccess: AccountAccessCheck,
	signal?: AbortSignal,
) {
	return (await resolveAccountSession(checkAccess, signal)).status;
}

/** Each application supplies its own protected access check, stable across renders. */
export function useAccountSession(checkAccess: AccountAccessCheck) {
	const current = useRef({ checkAccess });
	if (current.current.checkAccess !== checkAccess)
		current.current = { checkAccess };
	const generation = current.current;
	const controller = useRef<AbortController | null>(null);
	const [attempt, setAttempt] = useState({ id: 0, foreground: true });
	const [state, setState] = useState({
		generation,
		attempt: 0,
		status: "loading" as AccountSessionStatus,
		userId: null as string | null,
	});
	const refresh = useCallback((foreground: boolean) => {
		controller.current?.abort();
		setAttempt((previous) => ({ id: previous.id + 1, foreground }));
	}, []);
	const retry = useCallback(() => refresh(true), [refresh]);
	useEffect(() => {
		// Rechecking an established session must not remount an unchanged account's form.
		const visible = () => {
			if (document.visibilityState === "visible") refresh(false);
		};
		const focused = () => refresh(false);
		window.addEventListener("focus", focused);
		document.addEventListener("visibilitychange", visible);
		return () => {
			window.removeEventListener("focus", focused);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [refresh]);
	useEffect(() => {
		const request = new AbortController();
		controller.current = request;
		const settle = (result: {
			status: AccountSessionStatus;
			userId: string | null;
		}) => {
			if (!request.signal.aborted && current.current === generation)
				setState({ generation, attempt: attempt.id, ...result });
		};
		void resolveAccountSession(checkAccess, request.signal)
			.then(settle)
			.catch(() => settle({ status: "error", userId: null }));
		return () => request.abort();
	}, [checkAccess, attempt, generation]);
	const status =
		state.generation !== generation ||
		(attempt.foreground && state.attempt !== attempt.id)
			? "loading"
			: state.status;
	return {
		status,
		userId:
			status === "authenticated" || status === "restricted"
				? state.userId
				: null,
		retry,
	};
}
