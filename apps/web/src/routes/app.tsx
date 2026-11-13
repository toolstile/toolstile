import {
	createFileRoute,
	Outlet,
	redirect,
	useLocation,
} from "@tanstack/react-router";
import { approvalListFilter } from "@toolstile/api/approval-contract";
import { connectorSearch } from "@toolstile/api/connectors";
import {
	accessSearch,
	activitySearch,
	dashboardSearch,
} from "@toolstile/api/contract";
import { z } from "zod";
import { DashboardApp } from "../DashboardApp";
import { discardLegacyDialogSearch } from "../dashboard-local-dialogs";
export const Route = createFileRoute("/app")({
	validateSearch: (search) =>
		dashboardSearch
			.extend(accessSearch.shape)
			.extend(connectorSearch.shape)
			.extend(activitySearch.shape)
			.extend({
				authMode: z.enum(["signin", "signup"]).optional().catch(undefined),
				debugPayloadId: z.string().min(1).max(200).optional().catch(undefined),
				// Approvals and activity pages: status filter, page and the request under review.
				// `query` (from the access view) doubles as their search.
				status: approvalListFilter.optional().catch(undefined),
				page: z.coerce
					.number()
					.int()
					.min(1)
					.max(1000)
					.optional()
					.catch(undefined),
				approvalId: z.string().min(1).max(200).optional().catch(undefined),
				// Tool reviews page: the connection under review.
				connection: z.string().min(1).max(200).optional().catch(undefined),
			})
			.parse(search),
	beforeLoad: ({ location }) => {
		const search = discardLegacyDialogSearch(location.searchStr);
		if (search !== location.searchStr)
			throw redirect({
				href: `${location.pathname}${search}${location.hash ? `#${location.hash}` : ""}`,
				replace: true,
				resetScroll: false,
			});
	},
	component: DashboardLayout,
});
function DashboardLayout() {
	const path = useLocation({
		select: (location) => location.pathname.slice("/app/".length),
	});
	// Every /settings/* subpage is the "settings" section; the rest names the subpage.
	const [section, settingsPage] = path.split("/");
	return (
		<DashboardApp section={section} settingsPage={settingsPage}>
			<Outlet />
		</DashboardApp>
	);
}
