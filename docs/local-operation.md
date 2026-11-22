# Local PGlite instance

A local instance runs the production server with PGlite, which embeds PostgreSQL in the server process: no Docker, PostgreSQL server, Redis or hosted account. Run it as the single executable `toolstile-server` or from a source checkout; both run the same commands on the same data directory. The executable is built and its lifecycle tested in CI on macOS arm64, Linux x64 and Linux arm64. Windows is not supported.

## With npx

```sh
npx toolstile server start
```

The `toolstile` CLI downloads `toolstile-server` for your platform from the latest [release](https://github.com/toolstile/toolstile/releases), checks it against the release's SHA-256 checksum, initializes an instance in `~/.local/share/toolstile` on first use and runs `start` in the foreground. Stop it with Ctrl-C. The rest of this page applies unchanged: run the commands below as `npx toolstile server <command>`, or run the installed executable directly.

## Single executable

`toolstile-server` is a Node.js 26 single executable application: Node.js, the server, its static assets, PGlite's WebAssembly and the migrations in one file, with nothing else to install. Each [release](https://github.com/toolstile/toolstile/releases) publishes `toolstile-server-<os>-<arch>.br`, the Brotli-compressed executable for `darwin-arm64`, `linux-x64` and `linux-arm64`, and `toolstile-server-<os>-<arch>.sha256`, the checksum of the decompressed executable. Each `.br` file carries a GitHub build provenance attestation; check one with `gh attestation verify toolstile-server-linux-x64.br --repo toolstile/toolstile`.

To build it for the current platform from a source checkout (below):

```sh
vp run build:binary
```

This writes `dist/toolstile-server-<os>-<arch>` and its SHA-256 checksum (`--compress` also writes the `.br` file). Install it on your `PATH` under the name `toolstile-server`, for example on macOS on Apple silicon:

```sh
mkdir -p ~/.local/bin
install -m 755 dist/toolstile-server-darwin-arm64 ~/.local/bin/toolstile-server
export PATH="$HOME/.local/bin:$PATH" # add this line to your shell profile to keep it
toolstile-server init
toolstile-server start
```

`toolstile-server version` prints the release it was built from. The commands and options are those of `node scripts/local.mjs` described below.

## Source checkout

The source checkout uses [Vite+](https://viteplus.dev) (`vp`) with Node.js 26 (`.node-version` selects the latest installed 26) and pnpm 11.20.0; CI is verified on 26.13.1. From the repository root:

```sh
vp install --frozen-lockfile
vp run build
node scripts/local.mjs init
node scripts/local.mjs start
```

## The first account

When an instance has no accounts, listens on loopback and uses a plain HTTP loopback origin (the defaults), `start` prints a one-time setup link once the server is listening:

```text
Toolstile is running at http://127.0.0.1:4310

Finish setup (link works once, expires in 15 minutes):
  http://127.0.0.1:4310/auth/setup#<token>

Then connect Claude Code:
  claude mcp add --transport http toolstile http://127.0.0.1:4310/mcp
```

Open the link and create your account with an email and password. That account becomes the instance operator, signs in and lands in the dashboard's guided setup. The token sits in the URL fragment, so the browser never sends it to the server's access log or in a Referer header. The instance stores only its SHA-256 digest. The link works once and expires after 15 minutes. Each `start` while there are still no accounts issues a new link and the previous one stops working; once any account exists, `start` prints no link.

The setup request must come from the instance's own origin. An instance on a plain HTTP loopback origin also refuses requests whose `Host` header names any other host (status 421), so a web page that points its own host name at 127.0.0.1 (DNS rebinding) cannot reach it.

An instance with an HTTPS origin, one listening beyond loopback, or one that already has accounts invites its first or next account with `bootstrap` instead, which also works on every instance:

```sh
node scripts/local.mjs bootstrap you@example.com
node scripts/local.mjs start
```

While `start` is running, open the printed invitation URL (valid for 24 hours) and register. That account can add connections, connect agents and set access straight away.

To invite other people or change instance settings, the account needs operator access. The setup-link account already has it. For an invited account, stop the server (Ctrl-C) first, because the administrative commands open the same PGlite directory, then start it again:

```sh
node scripts/local.mjs operator you@example.com
node scripts/local.mjs start
```

Operators manage registration and users without viewing another user's connections, credentials or activity. Registration defaults to invitations. Each person remains independent; this installation does not add team collaboration.

## Data and lifecycle

The default origin is `http://127.0.0.1:4310`. The persistent directory defaults to `~/.local/share/toolstile`. Use `--data-dir /absolute/path` consistently on every command, or set `TOOLSTILE_DATA_DIR`. `instance.json` contains the stable authentication and encryption keys and listening configuration; `pglite/` contains the application data. Keep both private, on the server's local disk. Do not put the database on NFS, SMB, a cloud-synced folder or a file share. Devices connect to the server's HTTP endpoint and never open the database file. Keep the machine awake while clients need the gateway.

`init` never replaces an existing configuration and applies pending migrations. `start` also migrates before accepting requests. Stop with SIGINT/SIGTERM. After a restart, accounts, encrypted credentials, grants, approval deadlines and persistent maintenance/outbox work remain. Open protocol connections can be interrupted; reconnect the client. Uncertain upstream actions must not be replayed automatically. Maintenance retries due work every minute while the server is running. The bundled catalog works without toolstile.com; fetching a remote catalog is optional through `TOOLSTILE_CATALOG_FETCH`.

## Connecting agents with the CLI

With the server running, the `toolstile` CLI (version 0.8.0 or later; earlier releases cannot sign in to or set up agents on this server) can sign in to it and set up the agent apps on this computer. Use the instance origin, `http://127.0.0.1:4310` by default:

```sh
npx toolstile auth login --server http://127.0.0.1:4310
npx toolstile mcp setup
```

The link it prints opens `/auth/device` on the instance; sign in there, check the code and approve. Each agent app gets its own agent under this computer's device, with no access until you grant it in the dashboard. `npx toolstile auth logout` ends only the CLI's session. The CLI accepts `http://` only for a loopback origin (`localhost`, `127.0.0.0/8`, `[::1]`); other machines sign in through the HTTPS origin described below.

## Multiple devices and secure LAN access

Register a separate device and agent for each client in the dashboard (or sign each machine's CLI in as above), copy its endpoint/credential configuration and grant only the connections/capabilities it needs. Revoking one agent removes that agent's access without reviving or changing another agent. Credentials belong to this instance's issuer and audience; do not reuse credentials from another installation.

For other devices, choose a stable HTTPS hostname and configure a TLS reverse proxy to this instance. Prefer keeping Node on loopback and exposing only the proxy. Initialize a new directory with that public origin:

```sh
node scripts/local.mjs init --data-dir /srv/toolstile --origin https://gateway.example.com
```

If the proxy is on another machine, explicitly bind with `--listen <private-interface-address>` and restrict that port to the proxy with the host firewall. The public origin must still use HTTPS. `init` rejects plain HTTP LAN origins. Trust the proxy's certificate on every client; do not disable TLS verification. Configure upstream OAuth applications with the exact callback `https://gateway.example.com/oauth/upstream/callback`. Dashboard sign-in OAuth callbacks are under `/api/auth/callback/<provider>`. Provider-specific registrations may reject private hostnames; validate them before relying on that provider. A tunnel or proxy supplies reachability; all clients still need application authentication and individual grants.

## Upgrade, backup and restore

Before upgrading, stop the instance and take a manual backup, then retain the exact old executable or application commit alongside it. Backup requires the instance to be stopped. An ownership lock prevents another process from opening its PGlite directory. The backup command uses PGlite's data-directory archive. No scheduled backup service is installed.

```sh
node scripts/local.mjs backup /safe/new-backup-directory --data-dir /srv/toolstile
```

The command refuses an existing destination. It copies the database and stable key/configuration, then writes checksums. Protect the backup as sensitive data: it contains both ciphertext and its decryption key. Losing the key makes stored credentials unrecoverable.

Replace the executable with the newer release, or check out the newer source release, install its frozen dependencies and build it, then start with the same data directory. Migrations are journaled and hash checked, serialize against concurrent migrations and do not reapply completed steps. A changed applied migration fails rather than silently altering history. Never edit an applied migration to make an upgrade succeed.

To restore, stop the old instance and use a new, absent target directory:

```sh
node scripts/local.mjs restore /safe/new-backup-directory --data-dir /srv/toolstile-restored
node scripts/local.mjs start --data-dir /srv/toolstile-restored
```

Restore verifies checksums, validates the saved configuration and opens the archived PostgreSQL cluster, and refuses to overwrite any existing instance. Start with the application release that created the backup before attempting another upgrade. Restoring an older snapshot discards later application writes; do not start both restored and original instances against the same public endpoint. Reverting the executable or source alone after a schema upgrade is not a database rollback. Retain the original directory until the restored service is verified, then retire it explicitly.

## Verification status

CI runs the executable lifecycle on macOS arm64, Linux x64 and Linux arm64; the PGlite lifecycle suite runs on Linux and is exercised locally on macOS arm64. Local tests do not certify other operating systems or external OAuth registrations.
