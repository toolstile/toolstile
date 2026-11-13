import { createFileRoute, Link } from "@tanstack/react-router";
import { ToolReviewPanel } from "@toolstile/ui/tool-reviews";
import { useDashboardApp } from "../dashboard-context";
export const Route = createFileRoute("/app/tool-reviews")({
	component: ToolReviews,
});
function ToolReviews() {
	const search = Route.useSearch();
	const { instanceApi, userId, data } = useDashboardApp();
	return (
		<ToolReviewPanel
			api={instanceApi}
			connections={data.connections}
			scopeKey={userId}
			view={{ connection: search.connection }}
			renderLink={({ view, children, ...props }) => (
				<Link
					to="/app/tool-reviews"
					resetScroll={false}
					search={(previous) => ({ ...previous, connection: view.connection })}
					{...props}
				>
					{children}
				</Link>
			)}
		/>
	);
}
