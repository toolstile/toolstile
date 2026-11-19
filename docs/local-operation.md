# Local PGlite instance

The source checkout uses [Vite+](https://viteplus.dev) (`vp`) with Node.js 24 (`.node-version` selects the latest installed 24) and pnpm 11.20.0; CI is verified on 24.17.0. PGlite embeds PostgreSQL in the Node process; this runtime needs no Docker, PostgreSQL server, Redis or hosted account. Local mode is tested on macOS arm64. Linux and Windows are not yet verified.

From the repository root:

```sh
vp install --frozen-lockfile
vp run build
node scripts/local.mjs init
node scripts/local.mjs bootstrap you@example.com
node scripts/local.mjs start
```

While `start` is running, open the printed invitation URL (valid for 24 hours) and register. That account can add connections, connect agents and set access straight away.

To invite other people or change instance settings, make the account an operator. Stop the server (Ctrl-C) first, because the administrative commands open the same PGlite directory, then start it again:

```sh
node scripts/local.mjs operator you@example.com
node scripts/local.mjs start
```

Operators manage registration and users without viewing another user's connections, credentials or activity. Registration defaults to invitations. Each person remains independent; this installation does not add team collaboration.

The default origin is `http://127.0.0.1:4310`. The persistent directory defaults to `~/.local/share/toolstile`. Use `--data-dir /absolute/path` consistently on every command, or set `TOOLSTILE_DATA_DIR`. `instance.json` contains the stable authentication and encryption keys and listening configuration; `pglite/` contains the application data. Keep both private, on the server's local disk. Do not put the database on NFS, SMB, a cloud-synced folder or a file share. Devices connect to the server's HTTP endpoint and never open the database file. Keep the machine awake while clients need the gateway.

`init` never replaces an existing configuration and applies pending migrations. `start` also migrates before accepting requests. Stop with SIGINT/SIGTERM. After a restart, accounts, encrypted credentials, grants, approval deadlines and persistent maintenance/outbox work remain. Open protocol connections can be interrupted; reconnect the client. Uncertain upstream actions must not be replayed automatically. Maintenance retries due work every minute while the server is running. The bundled catalog works without toolstile.com; fetching a remote catalog is optional through `TOOLSTILE_CATALOG_FETCH`.

## Multiple devices and secure LAN access

Register a separate device and agent for each client in the dashboard, copy its endpoint/credential configuration and grant only the connections/capabilities it needs. Revoking one agent removes that agent's access without reviving or changing another agent. Credentials belong to this instance's issuer and audience; do not reuse credentials from another installation.

For other devices, choose a stable HTTPS hostname and configure a TLS reverse proxy to this instance. Prefer keeping Node on loopback and exposing only the proxy. Initialize a new directory with that public origin:

```sh
node scripts/local.mjs init --data-dir /srv/toolstile --origin https://gateway.example.com
```

If the proxy is on another machine, explicitly bind with `--listen <private-interface-address>` and restrict that port to the proxy with the host firewall. The public origin must still use HTTPS. `init` rejects plain HTTP LAN origins. Trust the proxy's certificate on every client; do not disable TLS verification. Configure upstream OAuth applications with the exact callback `https://gateway.example.com/oauth/upstream/callback`. Dashboard sign-in OAuth callbacks are under `/api/auth/callback/<provider>`. Provider-specific registrations may reject private hostnames; validate them before relying on that provider. A tunnel or proxy supplies reachability; all clients still need application authentication and individual grants.

## Upgrade, backup and restore

Before upgrading, stop the instance and take a manual backup, then retain the exact old application commit alongside it. Backup requires the instance to be stopped. An ownership lock prevents another process from opening its PGlite directory. The backup command uses PGlite's data-directory archive. No scheduled backup service is installed.

```sh
node scripts/local.mjs backup /safe/new-backup-directory --data-dir /srv/toolstile
```

The command refuses an existing destination. It copies the database and stable key/configuration, then writes checksums. Protect the backup as sensitive data: it contains both ciphertext and its decryption key. Losing the key makes stored credentials unrecoverable.

Check out the selected newer source release, install its frozen dependencies, build it and start with the same data directory. Migrations are journaled and hash checked, serialize against concurrent migrations and do not reapply completed steps. A changed applied migration fails rather than silently altering history. Never edit an applied migration to make an upgrade succeed.

To restore, stop the old instance and use a new, absent target directory:

```sh
node scripts/local.mjs restore /safe/new-backup-directory --data-dir /srv/toolstile-restored
node scripts/local.mjs start --data-dir /srv/toolstile-restored
```

Restore verifies checksums, validates the saved configuration and opens the archived PostgreSQL cluster, and refuses to overwrite any existing instance. Start with the application release that created the backup before attempting another upgrade. Restoring an older snapshot discards later application writes; do not start both restored and original instances against the same public endpoint. Reverting source alone after a schema upgrade is not a database rollback. Retain the original directory until the restored service is verified, then retire it explicitly.

## Verification status

macOS arm64 is the exercised local platform; local tests do not certify other operating systems or external OAuth registrations.
