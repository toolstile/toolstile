import { createFileRoute } from "@tanstack/react-router";
import { connectorLogoResponse } from "@toolstile/api/connector-logos";
import { catalogSource } from "../server/catalog";

// Content-addressed catalog logos: immutable, cookie-free and the same for every viewer.
const serve = ({ request }: { request: Request }) =>
	connectorLogoResponse(catalogSource(), request);
export const Route = createFileRoute("/connector-logos/$file")({
	server: { handlers: { GET: serve, HEAD: serve } },
});
