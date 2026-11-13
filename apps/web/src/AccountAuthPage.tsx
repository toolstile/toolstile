import { useNavigate, useSearch } from "@tanstack/react-router";
import { AuthScreen } from "@toolstile/ui";
import {
	accountAuthHref,
	safeLocalReturnTo,
} from "@toolstile/ui/account-navigation";

/** Normal account pages use explicit local destinations; signed agent flows stay embedded. */
export function AccountAuthPage({ mode }: { mode: "signin" | "signup" }) {
	const context = useSearch({ from: "/auth" });
	const navigate = useNavigate();
	const callbackURL = safeLocalReturnTo(context.returnTo);
	return (
		<AuthScreen
			mode={mode}
			onModeChange={(next) =>
				void navigate({
					href: accountAuthHref(
						next === "signup" ? "sign-up" : "sign-in",
						context,
					),
				})
			}
			modeHref={accountAuthHref(
				mode === "signup" ? "sign-in" : "sign-up",
				context,
			)}
			recoveryHref={accountAuthHref("recover-account", context)}
			callbackURL={callbackURL}
			initialEmail={context.email}
			invitationToken={context.invite}
			onReady={() => void navigate({ href: callbackURL, replace: true })}
		/>
	);
}
