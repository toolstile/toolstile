import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ApprovalPanel, type ApprovalView } from "@toolstile/ui/approvals";
import { useDashboardApp } from "../dashboard-context";
export const Route = createFileRoute("/app/approvals")({
	component: Approvals,
});
const approvalSearch = (view: ApprovalView) => ({
	status: view.status,
	query: view.query,
	page: view.page,
	approvalId: view.approvalId,
});
function Approvals() {
	const navigate = useNavigate();
	const search = Route.useSearch();
	const { instanceApi, userId, data } = useDashboardApp();
	return (
		<ApprovalPanel
			api={instanceApi}
			connections={data.connections}
			scopeKey={userId}
			view={{
				status: search.status,
				query: search.query,
				page: search.page,
				approvalId: search.approvalId,
			}}
			onViewChange={(view, replace) =>
				navigate({
					to: "/app/approvals",
					replace,
					resetScroll: false,
					search: (previous) => ({
						...previous,
						...approvalSearch(view),
					}),
				})
			}
			renderLink={({ view, children, ...props }) => (
				<Link
					to="/app/approvals"
					resetScroll={false}
					search={(previous) => ({
						...previous,
						...approvalSearch(view),
					})}
					{...props}
				>
					{children}
				</Link>
			)}
		/>
	);
}
