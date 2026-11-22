# Toolstile

**Give Claude Code your GitHub tools, but not the delete ones.**

Toolstile is an open-source MCP gateway that gives each coding agent its own endpoint with only the tools you allow. Mark a tool *Require approval* and its calls are refused until you approve the exact arguments in your browser.

```sh
npx toolstile server start
```

Open the setup link it prints to create your account, then run `claude mcp add --transport http toolstile http://127.0.0.1:4310/mcp`.

<img src="./.github/assets/banner.png" alt="Toolstile: connect your tools once, set each agent's access. A grid showing Claude Code, Codex and Cursor with allow, partial and deny access to each MCP server." />

[![Website](https://img.shields.io/badge/website-toolstile.com-1d4ed8?style=flat-square)](https://www.toolstile.com)
[![Docs](https://img.shields.io/badge/docs-toolstile.com%2Fdocs-1d4ed8?style=flat-square)](https://www.toolstile.com/docs)
[![License](https://img.shields.io/badge/license-Apache--2.0-1d4ed8?style=flat-square)](LICENSE)

Connect your remote MCP servers once, then give Claude Code, Codex, Cursor and other agents one endpoint each. Upstream credentials stay in Toolstile, encrypted; agents never see them.

## Try it

Every path opens the same guided setup in the dashboard and ends with Claude Code calling a real MCP server through Toolstile. The steps assume [Claude Code](https://code.claude.com/docs) is installed; for other clients, see [Connect other agents](#connect-other-agents).

### On your machine

`npx toolstile server start` downloads the `toolstile-server` executable for your platform (macOS on Apple silicon, Linux x64 or Linux arm64), checks it against its published checksum and runs it. The database is embedded, so there is no Docker or database server to set up. Data and keys live in `~/.local/share/toolstile`.

1. Run `npx toolstile server start`. On a new instance it prints a setup link that works once and expires in 15 minutes. Open it and create your account; it stays on this machine. If the link expires, stop the server with Ctrl-C and start it again for a new one.
2. On **MCP connections**, open **Browse catalog**, find **DeepWiki** and select **Connect**, then **Add connection**. DeepWiki needs no sign-in.
3. Keep the server running. In another terminal, in the directory where you use Claude Code, run:

   ```sh
   claude mcp add --transport http toolstile http://127.0.0.1:4310/mcp
   ```

   Start Claude Code there, run `/mcp`, choose `toolstile` and sign in through your browser. Select **Continue to permissions**, then **Allow connection**.
4. On **Access**, allow DeepWiki's tools for Claude Code and select **Save changes**.
5. Restart Claude Code so it loads the tools, then ask: *"List the DeepWiki tools you have through Toolstile, then call one that only reads data and show me what it returns."* The call shows up under **Activity**.

[Local operation](docs/local-operation.md) covers administrator access for inviting other people, HTTPS and LAN access, upgrades and backups.

### Hosted

[Create a free account](https://app.toolstile.com/auth/sign-up), then follow steps 2 to 5 above with the hosted address in step 3:

```sh
claude mcp add --transport http toolstile https://mcp.toolstile.com/mcp
```

### Build from source

Needs [Vite+](https://viteplus.dev) (`vp`) and Node.js 26 as your `node` (check with `node -v`).

```sh
git clone https://github.com/toolstile/toolstile.git
cd toolstile
vp install --frozen-lockfile
vp run build
node scripts/local.mjs init
node scripts/local.mjs start
```

`start` prints the same one-time setup link; open it, create your account and follow steps 2 to 5 above. `vp run build:binary` builds the single executable for your platform instead.

## What it does

- **One endpoint per agent.** Each agent sees only what it has been granted, combined from all of your connections.
- **Any MCP server.** Add a remote one by URL (Streamable HTTP or SSE) and sign in with OAuth or set headers; a bundled catalog fills in common servers. In local mode, operators can also run stdio servers as local commands.
- **Per-agent access.** Allow everything, including tools added later, or pick individual tools, resources and prompts. Blocks always win. Rules can apply to all agents, including future ones.
- **Approvals.** Mark a tool *Require approval* and a call to it returns a review link instead of running. After you approve the exact arguments in your browser, the agent retries the identical call. See [approvals](docs/approvals.md).
- **Tool review.** Turned on per connection: new or changed tool definitions are held until you accept them. See [tool review](docs/tool-review.md).
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

- Stdio MCP servers run only in local mode, when the operator starts the server with `TOOLSTILE_STDIO=on` ([local commands](docs/local-operation.md#local-commands)). Container and Kubernetes deployments reach them through a stdio-to-HTTP bridge.
- One application replica. MCP sessions reconnect after a restart.
- Executables are published with each release; there is no container image yet. The `toolstile` npm package is the CLI that downloads and runs the server.
- Local mode runs on macOS on Apple silicon and on Linux x64 and arm64, and CI tests the executable on all three. Windows is not supported. The container image you build is Linux.

## Related projects

- [`toolstile` CLI](https://github.com/toolstile/cli): `npx toolstile audit` checks the MCP configs on your machine for plaintext secrets, and `npx toolstile mcp setup` connects your local agents to Toolstile.
- [Toolstile plugins](https://github.com/toolstile/plugins): install Toolstile as a plugin in Claude Code or Cursor.

## Issues and contributing

[Open an issue](https://github.com/toolstile/toolstile/issues/new/choose) for bugs, feature requests and MCP server or client compatibility, whether you self-host or use the hosted service. Issues are public: never include tokens, API keys, account emails or request data. Account and billing questions go to [support@toolstile.com](mailto:support@toolstile.com).

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, checks and DCO sign-off, and the [documentation index](docs/README.md) lists everything else.

## License

[Apache-2.0](LICENSE). Third-party notices are in [NOTICE](NOTICE). The hosted service is provided under its [terms](https://www.toolstile.com/terms).
