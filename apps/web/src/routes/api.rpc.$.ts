import { createFileRoute } from "@tanstack/react-router";
import { handleRpc } from "../server/runtime";
export const Route = createFileRoute("/api/rpc/$")({
	server: {
		handlers: {
			GET: ({ request }) => handleRpc(request),
			POST: ({ request }) => handleRpc(request),
		},
	},
});
