import { createFileRoute } from "@tanstack/react-router";
import { gateway } from "../server/runtime";
export const Route = createFileRoute("/mcp")({
	server: {
		handlers: {
			GET: ({ request }) => gateway(request),
			POST: ({ request }) => gateway(request),
			DELETE: ({ request }) => gateway(request),
		},
	},
});
