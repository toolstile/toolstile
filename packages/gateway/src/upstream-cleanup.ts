import {
	type Client,
	StreamableHTTPClientTransport,
	type Transport,
} from "@modelcontextprotocol/client";

/** All owners of an upstream client (including watches) release its remote session. Only a
 * Streamable HTTP session is terminated remotely; closing any other transport ends it. */
export function withSessionCleanup(client: Client, transport: Transport) {
	const close = client.close.bind(client);
	let closing: Promise<void> | undefined;
	client.close = () =>
		(closing ??= (async () => {
			if (
				transport instanceof StreamableHTTPClientTransport &&
				transport.sessionId
			) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						transport.terminateSession().catch(() => {}),
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, 2000);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
			}
			// Closing aborts any termination I/O still pending at the deadline.
			await close();
		})());
}
