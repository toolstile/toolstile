import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { ApprovalRouter } from "./approval-server.js";
import type {
	AccountRouter,
	AllAgentGrantRouter,
	CommonRouter,
} from "./server.js";
import type { ToolReviewRouter } from "./tool-review-server.js";

export type ManagementClient = RouterClient<CommonRouter>;
export type AccountClient = RouterClient<AccountRouter>;
export type AllAgentGrantClient = RouterClient<AllAgentGrantRouter>;
export type ApprovalClient = RouterClient<ApprovalRouter>;
export type ToolReviewClient = RouterClient<ToolReviewRouter>;

/** The management procedures shared by every host; optional capabilities use their own clients. */
export function createClient(
	url: string,
	headers?: () => Record<string, string>,
) {
	return createORPCClient<ManagementClient>(new RPCLink({ url, headers }));
}
