# Gateway protocol support

The gateway pins the MCP TypeScript client and server SDKs to **2.3.1**. The
supported HTTP paths are covered by local SDK and loopback HTTP fixtures;
these fixtures do not establish interoperability with native client applications.

- **2026-07-28 Streamable HTTP:** per-request metadata and negotiation,
  tools/prompts/resources, protected MRTR continuations, and
  `subscriptions/listen`. Listen streams bridge modern sources, legacy
  Streamable HTTP sources and explicitly configured HTTP+SSE sources. They
  acknowledge first, stamp the downstream subscription ID, filter notifications,
  and translate resource URIs. Catalog-change filters are acknowledged only when
  a permitted source supports them. Unavailable resource subscriptions are
  rejected before acknowledgement.
- **Legacy Streamable HTTP sessions:** authenticated initialization, GET streams,
  DELETE, resource subscribe/unsubscribe, originating-client interactions, and
  resource updates from either modern or legacy sources. Catalog-change
  forwarding on this path is limited to resource-list changes received through
  an active resource subscription; it does not offer general tool/prompt watches.
- **HTTP+SSE sources:** the representative fixture exercises the endpoint event,
  separate message POSTs, discovery, tool execution, notifications, disconnect and
  explicit reconnection. This is upstream transport support; the gateway does
  not expose a separate downstream HTTP+SSE endpoint or a stdio transport.
- **stdio sources (local commands):** `Upstream.command` with `transport: "stdio"`
  starts a child process per operation (`LocalCommandTransport`) with the plain
  `initialize` handshake. It runs only when `Runtime.validateCommand` allows it;
  without that hook it fails closed. Every outgoing message passes the same
  admission, approval and metering guard as an HTTP request body. At most 8
  children run at once. Once a slot is held, `Runtime.validateCommand` repeats
  the caller's checks, then the owner's role and switch, and starts the child
  under the host's lock for access changes. A slot frees only when its child
  has exited.
  `closeLocalCommands` refuses queued and new starts, then stops them at
  shutdown. Resource subscriptions and list-change watches skip stdio sources.

Modern streams have **no SSE IDs, `Last-Event-ID` replay, or automatic re-listen**,
as specified by [2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
After a source error, permission change or unexpected disconnect, clients must
re-listen and refetch. Closing the response or aborting its request releases
upstream watches. Gateway shutdown sends a completion; revocation discards
queued data and terminates the affected streams.

The session-capacity and replay details below describe the embedded Node gateway. A restart or deployment can interrupt streams; lost legacy sessions return 404 and require initialization again. Uncertain upstream calls are never replayed.

Embedded Node legacy session capacity is process-local: **10,000 total**, **32 per agent** and
**256 per owner/scope** by default, including initializations still pending.
`createMcpGateway` accepts `maxSessions`, `maxSessionsPerAgent` and
`maxSessionsPerOwner` to tune these limits. The principal is `Runtime.sessionKey`;
the final colon-delimited segment identifies the agent and the preceding prefix
identifies its owner/scope. Initialization uses an in-memory token bucket per
agent: **60 tokens**, refilling at **60 per minute** (one per second), configurable
with `sessionInitializationsPerMinute`. Deleting or expiring a session releases
capacity but does not reset its initialization bucket. Idle sessions expire after
30 minutes (`idleMs`). All capacity/rate denials retain HTTP 503 with the body
`Gateway session capacity reached`.

Closing an upstream Streamable HTTP client with a session ID first attempts the
SDK's `terminateSession()` DELETE, bounded to two seconds, then closes the client.
Unsupported DELETE, missing sessions and network failures are tolerated. SSE and
sessionless upstreams close without a DELETE; connection probes use the same cleanup.

Legacy replay uses the SDK event-store interface. History is **process-local and
session-bound**, limited by default to **256 events, 1 MiB and five minutes** per
session. `replayMaxEvents`, `replayMaxBytes` and `replayTtlMs` configure those
bounds. Expired, evicted, foreign and unauthorized cursors return HTTP 409 so the
client can initialize again and refetch. Replay checks current identity, rules
and runtime authorization and only re-delivers messages; it never executes a
tool again. Streams containing server-initiated questions cannot be replayed.
No durable or cross-process replay is provided.

The embedding runtime supplies authentication, destination validation, live
authorization and operation admission/recording. Set `Upstream.identityKey` to a
stable selected-account identity **including its credential/grant revision**;
provider objects cannot be compared for credential changes. The gateway checks
the captured identity, destination, headers and rules before initialization and
every network send, including after asynchronous admission. Tool calls, resource
reads, prompt gets and completions also recheck identity/rules and live
authorization after the upstream result, before returning or saving any capture.
These result checks run even when capture is disabled or declines to save.
Subscription and replay maintenance use the same generic runtime hooks. Listen streams are
bounded to 1,024 total, 16 per agent and 128 source watches/resources by default;
the first two limits are configurable with `maxSubscriptionStreams` and
`maxSubscriptionStreamsPerAgent`.

A runtime passed to `inspect()` must include the inspected source in
`connections()`, resolved freshly with the same identity and rules shape as the
descriptor supplied to `inspect()`. A stale descriptor is not a live lookup.

Actual Claude Code, Codex, Cursor and Claude Desktop acceptance still requires
the corresponding installed clients and authenticated accounts. No native-client
acceptance is claimed by these fixtures.

Upstream JSON-RPC batches are rejected before operation admission or network forwarding. Only transport initialization, discovery negotiation, notifications and session cleanup bypass operation admission; they still retain the live identity and destination checks described above (cleanup can only terminate its captured session). Other requests, including `ping` and `logging/setLevel`, pass through admission. The self-hosted runtime denies requests outside its tools/resources/prompts capability model; it does not forward arbitrary maintenance requests or treat them as free operations.

MCP ingress reads at most 2 MiB of actual request bytes within ten seconds before SDK routing or complete JSON parsing, for modern/legacy and new/established requests. Overflow returns HTTP 413; stalled body reads return 408. Declared Content-Length does not bypass the streaming bound. Response streams have separate lifetimes.
