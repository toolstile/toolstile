import { createFileRoute } from "@tanstack/react-router";
import { handleCli } from "../server/runtime";
export const Route = createFileRoute("/api/cli/$")({
	server: {
		handlers: {
			GET: ({ request }) => handleCli(request),
			POST: ({ request }) => handleCli(request),
			DELETE: ({ request }) => handleCli(request),
		},
	},
});
