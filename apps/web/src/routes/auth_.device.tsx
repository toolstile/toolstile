import { createFileRoute } from "@tanstack/react-router";
import {
	DeviceApproval,
	deviceApprovalSearch,
} from "@toolstile/ui/device-approval";

/** CLI sign-in approval. It needs a signed-in account, so it stays outside the `/auth` gate,
 * which shows its pages only to signed-out visitors. */
export const Route = createFileRoute("/auth_/device")({
	validateSearch: deviceApprovalSearch,
	head: () => ({
		meta: [
			{ title: "Sign in to the CLI · Toolstile" },
			{ name: "referrer", content: "same-origin" },
			{ name: "robots", content: "noindex" },
		],
	}),
	component: function DeviceApprovalPage() {
		const search = Route.useSearch();
		return (
			<DeviceApproval
				userCode={search.user_code}
				deviceName={search.device_name}
				next={search.next}
			/>
		);
	},
});
