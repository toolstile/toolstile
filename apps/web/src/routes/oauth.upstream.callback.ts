import { createFileRoute } from "@tanstack/react-router";
import { upstreamOAuthCallback } from "../server/runtime";
export const Route = createFileRoute("/oauth/upstream/callback")({
	server: {
		handlers: { GET: ({ request }) => upstreamOAuthCallback(request) },
	},
});
