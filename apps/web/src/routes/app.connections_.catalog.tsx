import { createFileRoute } from "@tanstack/react-router";
import { CatalogPage } from "../CatalogPage";
export const Route = createFileRoute("/app/connections_/catalog")({
	component: CatalogPage,
});
