import { createFileRoute, redirect } from "@tanstack/react-router";
// Instance administration moved into Settings; keep old links working.
export const Route = createFileRoute("/app/instance")({
	beforeLoad: () => {
		throw redirect({
			to: "/app/settings/instance",
			search: (previous) => previous,
			replace: true,
		});
	},
});
