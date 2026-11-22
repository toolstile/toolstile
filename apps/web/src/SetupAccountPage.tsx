import { useNavigate } from "@tanstack/react-router";
import { AuthScreen } from "@toolstile/ui";
import { AuthLoading } from "@toolstile/ui/auth-loading";
import { useEffect, useState } from "react";
import { dashboardHref } from "./account-navigation";

/**
 * The one-time setup link a fresh local instance prints on `start`. The token travels in the
 * URL fragment, which browsers never send to the server or in a Referer header. The first
 * account becomes the instance operator and lands in the dashboard's guided setup.
 */
export function SetupAccountPage() {
	const navigate = useNavigate();
	// The fragment exists only in the browser; an empty one is refused like a used link.
	const [token, setToken] = useState<string>();
	useEffect(() => setToken(window.location.hash.slice(1)), []);
	if (token === undefined) return <AuthLoading />;
	return (
		<AuthScreen
			mode="signup"
			onModeChange={() => {}}
			setupToken={token}
			callbackURL={dashboardHref}
			onReady={() => void navigate({ href: dashboardHref, replace: true })}
		/>
	);
}
