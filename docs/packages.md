# Workspace packages

The packages under `packages/` are the building blocks of the application in `apps/web`. They are **private, unversioned TypeScript source**: every `package.json` is `"private": true` at version `0.1.0`, nothing is published to a registry, and the `exports` maps point at `.ts`/`.tsx` files that the consuming build compiles. The entry points below are internal APIs and may change in any commit until versioned releases exist. Do not depend on them from outside this repository without pinning a commit.

Entry points marked *server* resolve to `null` under the `browser` export condition, so server secrets and database modules cannot enter browser bundles.

## `@toolstile/api`

oRPC contracts, routers and clients for the management API.

| Entry point | Purpose |
| --- | --- |
| `./contract` | Shared input schemas and validated dashboard search parameters |
| `./client` | Typed management, account, all-agent grant, approval and tool review clients |
| `./server` (server) | Common, account and all-agent grant routers and the RPC HTTP handler with origin checks |
| `./approval-contract`, `./approval-server` (server) | Tool-call approval schemas and the PostgreSQL approval store |
| `./tool-review-contract`, `./tool-review-server` (server) | Tool definition review schemas and the PostgreSQL review store |
| `./setup-contract`, `./setup-server` (server) | Guided setup state and its service/router |
| `./agent-tools` (server) | Read-only built-in agent tools: catalog search and the agent's own access |
| `./built-in-tools` | Names, titles and what each built-in agent tool can read, for display |
| `./connectors`, `./connector-client` | Catalog entry schema, field building, display matching and client |
| `./connector-server`, `./connector-logos` (both server) | Catalog service and router (preview and confirmed connect), operator OAuth clients and logo responses |
| `./catalog-source`, `./catalog-snapshot` (server; the snapshot only in Vite-built code) | The fetched v1 catalog with its bundled fallback snapshot |

## `@toolstile/auth`

`.` (server): Better Auth setup (`createAuth`), CLI device sign-in and the `/api/cli` handler (`cliDevicePlugins`, `createCliHttpHandler`), the agent OAuth provider with PKCE and consent, upstream OAuth flow storage, the AES-256-GCM `secretBox` used for stored credentials, token issuing and digests, and email helpers. See [packages/auth/README.md](../packages/auth/README.md).

## `@toolstile/database`

| Entry point | Purpose |
| --- | --- |
| `.` (server) | Drizzle schema tables, PostgreSQL column builders, PostgreSQL/PGlite adapters and locked migrations |
| `./connector-catalog` (server) | Idempotent connector request storage |
| `./sql` (server) | PostgreSQL query/result types |
| `./transaction` (server) | `transaction(pool, work, options)` on one checked-out PostgreSQL/PGlite connection (read committed by default, bounded retry of serialization failures and deadlocks) and `advisoryLock` for keys with no row to lock |
| `./pg-columns` (server) | PostgreSQL table and column builders for application schemas |

The application owns its current PostgreSQL migration history in `apps/web/postgres-migrations`, used by both embedded PGlite and server PostgreSQL. See [local operation](local-operation.md) and [server packaging](installation.md).

## `@toolstile/gateway`

`.` (server): the MCP gateway runtime (`createMcpGateway`), grant evaluation, approval gating, tool definition review, refusal explanations, debug capture, server detection, upstream OAuth, the outbound destination policy and local commands (stdio upstreams). Protocol support and limits are in [packages/gateway/README.md](../packages/gateway/README.md).

## `@toolstile/ui`

React components and StyleX styles, all browser-safe. `.` exports common components; subpaths are `./shell`, `./select`, `./controls`, `./layout`, `./tokens.stylex`, `./styles.css`, `./brand`, `./theme-switcher`, `./appearance`, `./setup`, `./setup-contract`, `./connections-page`, `./devices-page`, `./access-page`, `./activity-page`, `./connections-navigation`, `./connector-logo`, `./approvals`, `./tool-reviews`, `./connectors`, `./toast`, `./markdown`, `./status-badge`, `./url-text`, `./checkbox`, `./auth-loading`, `./device-approval`, `./auth-navigation`, `./account-navigation`, `./account-session` and `./account-gate`. React and React DOM are peer dependencies; consumers must compile StyleX in their build.
