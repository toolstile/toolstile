# Security policy

## Reporting a vulnerability

Email **support@toolstile.com** with "Security" in the subject. Do not open a public issue, discussion or pull request for a suspected vulnerability. Include the affected commit, configuration, reproduction steps and impact. Never send real credentials, tokens or another person's data; use synthetic accounts and fixtures. We will keep the report confidential while a fix is prepared and credit you if you wish.

Only the latest commit on `main` is supported; there are no versioned releases yet.

## Scope

In scope: this repository's application and packages, including the dashboard and management API, the MCP gateway endpoint, agent and upstream OAuth flows, credential storage, the Dockerfile, Compose file and Kubernetes manifests. The same process covers the managed service at `toolstile.com` and its subdomains, including the gateway at `mcp.toolstile.com`, the [`toolstile` CLI](https://github.com/toolstile/cli) and the [Toolstile plugins](https://github.com/toolstile/plugins); test only against accounts and workspaces you own.

Out of scope: vulnerabilities in upstream MCP servers or OAuth providers, deployments that ignore the [installation guide](docs/installation.md) (for example, a publicly exposed PostgreSQL port or a reused `ENCRYPTION_KEY`), denial of service by an authenticated operator of their own instance, and findings that require server or database access.

## Security model

This summarises what the code does today; it is not a certification.

- **User isolation.** Each user's connections, credentials, devices, agents, grants and activity are scoped to that user. Management RPC calls resolve the signed-in user on every request and look up records by owner. Instance operators manage invitations and user status but cannot view other users' credentials or activity. Mutating RPC requests must carry the instance's exact `Origin`.
- **Agent permissions.** The gateway resolves the agent's current grants before discovery and before every invocation. An explicit block always wins, and revocation and expiry are checked live. Agent tokens and other opaque tokens are stored as SHA-256 digests and shown once.
- **Encrypted credentials.** Upstream credentials, OAuth tokens, PKCE verifiers, approval parameters and debug captures are encrypted with AES-256-GCM using `ENCRYPTION_KEY` (32 random bytes, hex encoded). Losing the key makes them unrecoverable; changing it needs a credential migration.
- **OAuth.** Agent authorization uses the authorization-code flow and requires a PKCE `code_challenge`; signed authorization query bytes are verified before consent. Upstream OAuth uses the MCP SDK's discovery, PKCE and issuer binding. Upstream callbacks are bound to the signed-in user and session, expire after ten minutes and can be claimed once.
- **Destination policy.** Outbound requests to upstream servers validate the URL and every DNS answer before the request and again at connection time, so DNS rebinding cannot reach a refused address. Redirects are rejected. Cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`) are always refused. Private, loopback and unique-local addresses are refused only when an operator turns off **Allow private networks** in instance settings; that setting is on by default. Custom upstream headers cannot set `Host`, `Cookie`, hop-by-hop or `Mcp-*` headers.
- **Debug capture.** Activity records metadata only by default. Payload capture must be turned on for selected agents and connections, stops after one hour unless extended and keeps captures for at most 24 hours. Before encryption, captures are size-bounded and authentication-shaped fields (authorization, cookies, passwords, secrets, tokens, API keys, OAuth codes and verifiers) and credential patterns in strings (bearer and basic credentials, URL user info, token query parameters) are redacted. Redaction is pattern-based and cannot recognise every secret an upstream returns.
- **Untrusted content.** MCP descriptions are rendered as Markdown with raw HTML disabled and remote images replaced by their alt text.

Known limits: MCP sessions and interactive continuations live in one process, so run a single app replica. Interoperability with specific agent apps is tested with local fixtures, not every client release.
