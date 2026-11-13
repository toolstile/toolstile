import { createFileRoute } from "@tanstack/react-router";
import { agentOAuth } from "../server/runtime";
export const Route = createFileRoute("/api/agent-oauth")({
	server: {
		handlers: {
			GET: ({ request }) => agentOAuth(request),
			POST: ({ request }) => agentOAuth(request),
		},
	},
});
