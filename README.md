# Toolstile

[![Website](https://img.shields.io/badge/website-toolstile.com-1d4ed8?style=flat-square)](https://www.toolstile.com)
[![Docs](https://img.shields.io/badge/docs-toolstile.com%2Fdocs-1d4ed8?style=flat-square)](https://www.toolstile.com/docs)
[![License](https://img.shields.io/badge/license-Apache--2.0-1d4ed8?style=flat-square)](LICENSE)

An MCP gateway with per-agent access. Connect your remote MCP servers once, then give Claude Code, Codex, Cursor and other agents one endpoint each that exposes only the tools you allow. Upstream credentials stay in Toolstile, encrypted; agents never see them.

<img src="./.github/assets/banner.png" alt="Toolstile: connect your tools once, set each agent's access. A grid showing Claude Code, Codex and Cursor with allow, partial and deny access to each MCP server." />

## Try it

Both paths open the same guided setup in the dashboard and end with Claude Code calling a real MCP server through Toolstile. The steps assume [Claude Code](https://code.claude.com/docs) is installed; for other clients, see [Connect other agents](#connect-other-agents).

### Hosted

1. [Create a free account](https://app.toolstile.com/auth/sign-up).
2. On **MCP connections**, open **Browse catalog**, find **DeepWiki** and select **Connect**, then **Add connection**. DeepWiki needs no sign-in.
3. In the directory where you use Claude Code, run:

   ```sh
   claude mcp add --transport http toolstile https://mcp.toolstile.com/mcp
   ```

   Start Claude Code there, run `/mcp`, choose `toolstile` and sign in through your browser. Select **Continue to permissions**, then **Allow connection**.
4. On **Access**, allow DeepWiki's tools for Claude Code and select **Save changes**.
5. Restart Claude Code so it loads the tools, then ask: *"List the DeepWiki tools you have through Toolstile, then call one that only reads data and show me what it returns."* The call shows up under **Activity**.

### On your machine

Needs [Vite+](https://viteplus.dev) (`vp`) and Node.js 24 as your `node` (check with `node -v`). The database is embedded, so there is no Docker or database server to set up. Local mode is tested on macOS on Apple silicon.

```sh
git clone https://github.com/toolstile/toolstile.git
cd toolstile
vp install --frozen-lockfile
vp run build
node scripts/local.mjs init
node scripts/local.mjs bootstrap you@example.com
node scripts/local.mjs start
```

Use your own email with `bootstrap`. It prints an invitation link, valid for 24 hours, above the server's log. While `start` is running, open that link and create your account. The dashboard at `http://127.0.0.1:4310` opens the same guided setup: follow steps 2 to 5 above. Keep the server running and, in another terminal in the directory where you use Claude Code, connect Claude Code to your own address instead of the one in step 3:

```sh
claude mcp add --transport http toolstile http://127.0.0.1:4310/mcp
```

Data and keys live in `~/.local/share/toolstile`. [Local operation](docs/local-operation.md) covers administrator access for inviting other people, HTTPS and LAN access, upgrades and backups.

## What it does

- **One endpoint per agent.** Each agent sees only what it has been granted, combined from all of your connections.
- **Any remote MCP server.** Add one by URL (Streamable HTTP or SSE) and sign in with OAuth or set headers. A bundled catalog fills in common servers.
- **Per-agent access.** Allow everything, including tools added later, or pick individual tools, resources and prompts. Blocks always win. Rules can apply to all agents, including future ones.
- **Approvals.** Mark a tool *Require approval* and each call waits for you to approve or deny it. See [approvals](docs/approvals.md).
- **Tool review.** Turn on review for a connection and new or changed tool definitions are held until you accept them. See [tool review](docs/tool-review.md).
- **Agents and devices.** Agents sign in through a consent page and appear under their device. Remove a device to revoke every agent on it. Scripts can use per-agent tokens with an expiry.
- **Activity.** Call metadata is recorded by default. Payload capture is off until you start a time-limited capture for chosen agents and connections.
- **Multi-user instances.** Invitation-only registration, recovery codes and optional SMTP, GitHub or Google sign-in. Each user's connections, credentials, agents and activity are private to them.

Team workspaces and shared accounts are part of the hosted service only.

## Connect other agents

On **Devices & agents**, choose **Connect an agent** and pick your app for its exact setup. Any client that supports remote MCP with OAuth works. For example, Codex:

```sh
codex mcp add toolstile --url https://mcp.toolstile.com/mcp
codex mcp login toolstile
```

Use your own instance's `/mcp` address when self-hosting. A new agent starts with no access unless you have set a rule for all agents, so allow its tools on **Access** and select **Save changes**. Claude Desktop and ChatGPT connect from their providers' servers, so they need an instance reachable from the internet, not `127.0.0.1`.

## Run it on a server

- [Docker Compose](docs/containers.md): one host with PostgreSQL 17 behind your HTTPS reverse proxy.
- [Kubernetes](docs/kubernetes.md): the same image with your own PostgreSQL, Secrets and ingress.

[Installation](docs/installation.md) compares the options. To work on the code, read [architecture](docs/architecture.md), [packages](docs/packages.md) and [product scope](docs/product.md).

## Limitations

- Remote MCP servers only; Toolstile does not run local stdio servers.
- One application replica. MCP sessions reconnect after a restart.
- Self-hosting builds from source; there is no published image or package yet.
- Local mode is tested on macOS on Apple silicon only. The container image is Linux.

## Related projects

- [`toolstile` CLI](https://github.com/toolstile/cli): `npx toolstile audit` checks the MCP configs on your machine for plaintext secrets, and `npx toolstile mcp setup` connects your local agents to Toolstile.
- [Toolstile plugins](https://github.com/toolstile/plugins): install Toolstile as a plugin in Claude Code or Cursor.

## Issues and contributing

[Open an issue](https://github.com/toolstile/toolstile/issues/new/choose) for bugs, feature requests and MCP server or client compatibility, whether you self-host or use the hosted service. Issues are public: never include tokens, API keys, account emails or request data. Account and billing questions go to [support@toolstile.com](mailto:support@toolstile.com).

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, checks and DCO sign-off, and the [documentation index](docs/README.md) lists everything else.

## License

[Apache-2.0](LICENSE). Third-party notices are in [NOTICE](NOTICE). The hosted service is provided under its [terms](https://www.toolstile.com/terms).
