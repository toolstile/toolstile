# Connector catalog

The connections screen has **Connected** and **Browse catalog** views. Search by app or task, filter by category or sign-in method, and open a connector's details before connecting. **Custom URL** adds any server by its address. Browsing does not contact upstream servers.

The catalog is a list of suggestions published by www.toolstile.com (`GET /catalog/v1.json`) and read through the catalog source below, with a snapshot bundled in each release. It holds public provider metadata only: name, description, suggested endpoint, sign-in hints, settings, starters, a logo reference and the last observed tool snapshot. A connection is the MCP URL the person confirmed. Catalog changes never alter an existing connection, and a catalog account does not grant any agent access.

The published v1 wire contract may omit `listed` because the public feed contains visible entries only; the reader treats omission as true, preserves explicit false, and accepts null `toolSnapshot` as an unknown inventory. Invalid entries and operator client configuration are still rejected. A bundled fallback does not prove a successful feed refresh.

## Connecting

The catalog suggestion and a typed address use the same flow:

1. **Settings build the address in the browser.** A catalog entry's `fields` become query parameters of its suggested endpoint, encoded with `URLSearchParams`. `identifier` values must match `^[A-Za-z0-9_-]{1,128}$`, `boolean` values are `true` or `false` and `text` is free text up to 200 characters. There are no remote regular expressions.
2. **Preview.** `previewConnection({url})` applies the destination policy and then detection, including the `/mcp` and `/sse` probes for an address without a path. It returns the resolved URL, the transport and whether the server asks for sign-in, and saves nothing.
3. **Confirm.** The dialog shows the resolved address in an editable field. The person confirms it or edits it, and an edit is checked again before it can be saved. Sign-in method hints only choose the initial option; every method stays available.
4. **Create.** `connectConnector({requestId, url, authentication, transport?, headers?, label?, suggestionId?})` stores exactly the confirmed URL. It applies the destination policy and makes a real request to that exact URL with the chosen settings, even when transport and authentication are both given, never probing another path or rewriting the address. A failed check returns an error and saves nothing. The person's transport choice is kept. The catalog is never consulted to resolve the endpoint, so its availability never blocks creating or retrying a connection.

`suggestionId` is a display hint. It is stored in `connectorId` only when the confirmed URL still display-matches that catalog entry. The legacy `addConnection` procedure keeps its detect-and-save behaviour for API clients.

A request UUID prevents duplicate connections on retry. `connector_requests` is keyed by owner, scope and request UUID. Its HMAC fingerprint covers the confirmed URL, authentication, transport and headers (credentials included, never stored in plaintext), and not the display hint or label. Reusing a UUID with different settings, or after removing the resulting connection, is a conflict. The stored request is looked up and authorized before any network check: a request that already succeeded replays without a DNS lookup or a request to its server, so it returns even when that server or its DNS no longer answers, and a conflict is reported without a check. A new request ID always performs the real check. Responses contain IDs and non-secret connection metadata; they expire after 24 hours and periodic maintenance removes them.

API keys use the existing encrypted-header storage. OAuth continues through the session-bound provider flow.

## Operator OAuth clients

Some providers have no dynamic client registration. `UPSTREAM_OAUTH_CLIENTS` is a JSON list of `{"origin", "env", "issuer"}` read from the server environment, never from the catalog (the catalog source rejects any entry with `registeredClient`). Browser sign-in to a connection whose URL has exactly that origin uses `<env>_CLIENT_ID` and `<env>_CLIENT_SECRET`, bound to `issuer`; without both values, sign-in asks for registered client settings or an access token. Unset, the list is GitHub's MCP server: origin `https://api.githubcopilot.com`, env `GITHUB_MCP`, issuer `https://github.com/login/oauth`. An invalid value makes browser sign-in fail with a configuration error instead of being ignored. Existing encrypted grants and their issuer binding are unchanged.

## Catalog source

`@toolstile/api/catalog-source` holds the published connector catalog in memory for each server process. It fetches the v1 catalog from `TOOLSTILE_CATALOG_URL` (default `https://www.toolstile.com/catalog/v1.json`) and falls back to the snapshot bundled with this release, `packages/api/catalog/v1.json` plus `packages/api/catalog/logos/<sha256>.<svg|png|webp>`. Set `TOOLSTILE_CATALOG_FETCH=off` to make no catalog request at all; the bundled snapshot is then the catalog.

- **What is sent:** a plain GET with `User-Agent: Toolstile/<version>`, `Accept` and, after the first success, `If-None-Match`. No cookies, credentials, instance identifiers or user data are sent.
- **Egress:** public HTTPS on port 443 only, whatever the instance's private-network setting. DNS answers are checked again at connection time, redirects are failures, connecting may take 5 seconds and the whole request 10 seconds. The catalog body is capped at 1 MB and each logo at 256 KB while streaming.
- **Caching:** the last good copy is kept in memory. A refresh starts on the first read after five minutes and on a five-minute timer; only one runs at a time, and requests never wait for it. A 304 renews the copy. A failed refresh keeps the last good copy (or the snapshot) and is retried after the next interval. On a cold start a request waits at most 10 seconds before the snapshot is used.
- **Validation:** each entry is checked on its own; an invalid entry is skipped, unknown fields are ignored and unlisted entries are left out. Entries cannot carry operator OAuth clients (`registeredClient`) or regular expressions: a setting is `text`, `identifier` (letters, digits, `_` and `-`, at most 128) or `boolean`.
- **Logos** are fetched only from the catalog URL's own origin (`<catalog path without .json>/logos/<sha256>.<type>`), must match their SHA-256 and pass the [artwork](artwork.md) checks. Browsers never request them from that origin.

`pnpm catalog:pull [url] [--write]` replaces the bundled snapshot with a published v1 catalog fetched through the same egress policy; run it and commit the result before each release. `pnpm catalog:discover [slugs...] [--write]` lists the tools of sign-in-free entries (and bearer entries with `CATALOG_DISCOVER_TOKEN_<SLUG>`) with the gateway's own client, list requests only, and writes them as `toolSnapshot` into the bundled snapshot; www stays the published source. `tests/catalog-source.test.ts` checks the committed snapshot on its own (every entry valid and listed, no hidden connectors, every logo file present with its hash). Tests, the CI harness and worktree dev servers run with `TOOLSTILE_CATALOG_FETCH=off`.

Display matching (`matchCatalogEntry`) finds the entry for a connection URL by lowercase origin and path, ignoring a trailing slash and the query; otherwise the only entry with that host. It chooses a logo, the reviewed starters and suggested tool names, and never establishes identity.

## Logos

Logos are served by the app at content-addressed URLs, `/connector-logos/<slug>-<hash>.<svg|png|webp>`, where `<hash>` is the first 16 hex characters of the file's SHA-256 (`@toolstile/api/connector-logos`), from the catalog source's validated files. Catalog and connection responses carry only `logoUrl`, never logo data. A URL for an unknown or unlisted entry, another hash or another type returns 404 (`no-store`). A match returns the file with its content type, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` and no cookies; SVG also gets `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox`. HEAD returns the headers only. A changed logo gets a new URL, so caches never need purging.

## Catalog review

Every entry was probed live before inclusion. OAuth servers had to return 401 with protected-resource metadata whose `resource` matches the endpoint, and an authorization server offering dynamic client registration or client ID metadata documents and not refusing S256 PKCE. No-sign-in servers had to list tools, and servers whose tools might need credentials answered a real read-only call. Documentation links were checked to resolve to the publisher's own page. Plan, workspace-administrator and regional requirements are stated on each entry.

Servers that only offer client ID metadata documents (MongoDB, Bubble, Crunchbase) need the installation served from a public HTTPS address. Render accepts an API key only.

Excluded, and why:

- OAuth requires a pre-registered app or an approved-client list: Slack, Asana, HubSpot, Box, Xero, Discord, Front, Smartsheet, PagerDuty, Dropbox, Lovable, Gong, Greenhouse, PitchBook.
- Credentials must be sent in a custom header, the URL or a separate key exchange: Firecrawl, Browserbase, Alpaca, Instacart, Kaggle, Google Maps, BigQuery, Gorgias.
- No published documentation, or the endpoint is per tenant, unreleased or possibly retired: Zendesk, Wise, Product Hunt, Retool, Coda, Moody's, Salesforce, Pipedrive.
- Not a working MCP endpoint when probed: Angular, Storyblok, Linkup, Polygon.

Re-run the probe before re-adding any of these; provider policies change.

## Verification

`tests/connectors.test.ts` covers field building, display matching, the confirmed-request contract and fingerprint, starters, logo validation, search and operator OAuth configuration. `tests/catalog-inventory.test.ts` covers discovery into the bundled snapshot against the local MCP fixture. `tests/catalog-source.test.ts` covers the v1 schema, refresh and fallback behaviour, egress refusals, logo verification, display matching, the logo route and the committed snapshot. `tests/connector-catalog.test.ts` exercises preview, the exact-URL check, concurrent and replayed creation, conflicts, encryption and user isolation through typed HTTP and a disposable database.
