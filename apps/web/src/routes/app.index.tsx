import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/app/")({
	beforeLoad: () => {
		throw redirect({
			to: "/app/connections",
			search: (previous) => previous,
			replace: true,
		});
	},
});
