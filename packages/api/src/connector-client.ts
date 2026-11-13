import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { ConnectorRouter } from "./connector-server.js";
export type ConnectorClient = RouterClient<ConnectorRouter>;
export function createConnectorClient(
	url: string,
	headers?: () => Record<string, string>,
) {
	return createORPCClient<ConnectorClient>(new RPCLink({ url, headers }));
}
