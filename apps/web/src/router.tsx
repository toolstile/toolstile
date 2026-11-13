import {
	createRouter,
	defaultParseSearch,
	defaultStringifySearch,
} from "@tanstack/react-router";
import { oauthSearchSerialization } from "@toolstile/ui/auth-navigation";
import { routeTree } from "./routeTree.gen";
export function getRouter() {
	return createRouter({
		routeTree,
		scrollRestoration: true,
		...oauthSearchSerialization(defaultParseSearch, defaultStringifySearch),
	});
}
