# Test and compatibility status

## Supported versions

| Component | Version |
| --- | --- |
| Node.js | 24 LTS (`engines: >=24 <25`; `.node-version` selects 24; CI pins 24.17.0) |
| pnpm | 11 (`packageManager` pins 11.20.0) |
| PostgreSQL | Native PostgreSQL server adapter; embedded PGlite for local operation |
| MCP SDK | `@modelcontextprotocol/client` and `server` 2.3.1 |
| MCP transports | 2026-07-28 Streamable HTTP, legacy Streamable HTTP sessions and HTTP+SSE upstreams; see the [gateway README](../packages/gateway/README.md) |

Run one Node owner with PGlite on local disk using [local installation](local-operation.md), or use [Compose](containers.md) / [Kubernetes](kubernetes.md) with PostgreSQL. No Redis is required. One process owns live MCP sessions; multiple replicas and HA are not claimed.

## Test suites

Vitest runs the files in `tests/` and `packages/*/tests/`. They use local fixtures only: synthetic users, loopback MCP servers (modern, legacy and SSE) and a synthetic OAuth provider. No real third-party credentials are needed.

- **Gateway and protocol:** discovery, dispatch, grants and blocks, resource templates, subscriptions, legacy replay, interactive continuations, stream keep-alive, HTTP envelopes, races during dispatch and a bounded concurrency regression (a correctness check, not a capacity estimate).
- **Destination policy:** URL, port and DNS checks, connection-time rechecks and redirect refusal.
- **OAuth:** agent consent and authorization, upstream OAuth discovery, callbacks, refresh and replay refusal.
- **Accounts and administration:** registration policy, social sign-in linking, recovery and deletion, sessions, operator privacy and telemetry settings.
- **Approvals, debug capture and setup:** approval storage and gateway gating, debug capture authority, redaction, expiry and storage, guided setup.
- **Catalog and API:** connector catalog data, inventory and RPC contract schemas.

Direct Vitest runs skip HTTP/storage suites without fixture targets. Such a run always ends with an `INCOMPLETE` summary giving the number of skipped files and tests and the command that runs them (`pnpm build && pnpm test:local`). A run with skipped suites is not a full pass; use the owned PostgreSQL harness for complete acceptance.

## Running the tests

Run [the CI gates](ci.md) for complete acceptance. `pnpm test:local [files]` can select suites during development; `pnpm test` runs direct Vitest with HTTP/storage suites skipped when fixture targets are absent, and ends with the skip summary.

`pnpm test:local` runs `scripts/test-postgres.mjs`. It allocates a private temporary directory, Docker PostgreSQL database, independent keys and loopback port, races fresh migrations, repeats them, starts the built Node server and runs all suites. It removes the fixture after completion and does not load development dotenv. PGlite persistence, backup/restore and production assets are exercised separately within the complete suite. See [CI](ci.md) for gates and the explicit final-image acceptance command.

## Not covered

Interoperability with native agent apps (Claude Code, Codex, Cursor, Claude Desktop) is not part of the automated suites; local SDK and HTTP fixtures establish protocol behavior, not compatibility with every client release. Real social sign-in providers, provider-specific upstream OAuth variants and SMTP delivery need external credentials and are not part of the automated suites.
