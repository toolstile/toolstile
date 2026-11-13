import { createFileRoute } from "@tanstack/react-router";
import { instanceRuntime } from "../server/runtime";
export const Route = createFileRoute("/health")({
	server: {
		handlers: {
			GET: async () => {
				try {
					await instanceRuntime().ready();
					return Response.json(
						{ status: "ok" },
						{ headers: { "Cache-Control": "no-store" } },
					);
				} catch {
					return Response.json(
						{ status: "unavailable" },
						{ status: 503, headers: { "Cache-Control": "no-store" } },
					);
				}
			},
		},
	},
});
