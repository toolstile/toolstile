import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import "@toolstile/ui/styles.css";
import {
	AppearanceRuntime,
	appearanceBootstrap,
} from "@toolstile/ui/appearance";
import { toolstileIconLinks } from "@toolstile/ui/brand";
import { ToastViewport } from "@toolstile/ui/toast";
export const Route = createRootRoute({
	head: () => ({
		links: [
			...toolstileIconLinks,
			...(import.meta.env.DEV
				? [{ rel: "stylesheet", href: "/virtual:stylex.css" }]
				: []),
		],
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Toolstile" },
		],
	}),
	component: () => (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
				{/* oxlint-disable-next-line react/no-danger -- Static first-party theme bootstrap contains no user input. */}
				<script dangerouslySetInnerHTML={{ __html: appearanceBootstrap }} />
			</head>
			<body>
				<AppearanceRuntime />
				<Outlet />
				<ToastViewport />
				<Scripts />
			</body>
		</html>
	),
});
