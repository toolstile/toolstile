import { createFileRoute } from "@tanstack/react-router";
import { upstreamClientMetadata } from "../server/runtime";
export const Route = createFileRoute("/oauth/client-metadata.json")({
	server: { handlers: { GET: () => upstreamClientMetadata() } },
});
