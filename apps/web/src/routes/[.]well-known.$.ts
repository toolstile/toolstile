import { createFileRoute } from "@tanstack/react-router";
import { handleAuth } from "../server/runtime";
export const Route = createFileRoute("/.well-known/$")({
	server: {
		handlers: {
			GET: ({ request }) => handleAuth(request),
			OPTIONS: () =>
				new Response(null, {
					headers: {
						"Access-Control-Allow-Origin": "*",
						"Access-Control-Allow-Methods": "GET, OPTIONS",
					},
				}),
		},
	},
});
