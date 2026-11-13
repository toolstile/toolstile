import { createFileRoute, useRouter } from "@tanstack/react-router";
import { authorizationSearch } from "@toolstile/ui/auth-navigation";
import { AgentAuthorizationRoute } from "../route-helpers";
export const Route = createFileRoute("/authorize-agent")({
	validateSearch: authorizationSearch,
	component: function AuthorizationPage() {
		const { authMode } = Route.useSearch();
		const router = useRouter();
		return (
			<AgentAuthorizationRoute
				consent={false}
				authMode={authMode}
				push={(href) => router.history.push(href)}
			/>
		);
	},
});
