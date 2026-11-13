// Resolve test transport dependencies through the web application's own package.
export { createORPCClient } from "@orpc/client";
export { RPCLink } from "@orpc/client/fetch";
export { ORPCError, type RouterClient } from "@orpc/server";
export { RPCHandler } from "@orpc/server/fetch";
