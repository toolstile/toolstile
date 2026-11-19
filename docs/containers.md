# Containers and Docker Compose

This deploys the independent-user application, with one Node process and PostgreSQL 17. Each user's connections, credentials and agents remain isolated. Build the image from a reviewed source checkout; these instructions do not push it to any registry. Docker Engine with Compose v2 is required. Use an immutable image tag for each installation release, and retain the previous image.

The multi-stage Dockerfile builds in the digest-pinned Vite+ image (`ghcr.io/voidzero-dev/vite-plus`), installs the frozen lockfile with `vp` on Node 26.13.1 and pnpm 11.20.0, and copies the complete standalone output, migrations and bundled administrative CLI into a non-root runtime. No source checkout, build tools or dotenv files are required at runtime. The image supports native PostgreSQL only; use [local operation](local-operation.md) for embedded PGlite. Never share a PGlite directory between containers.

## Install

Run from the repository root. Choose an HTTPS origin you control, for example `https://tools.example.com`. The same origin serves the dashboard, OAuth and `/mcp`; a second MCP hostname is not supported by this packaging.

Generate secrets once, outside Git. The example generates a URL-safe database password. Protect these files and retain encrypted offline copies with database backups. Compose bind-mounted secret files must be readable by the container's UID 1000; on a multi-user host use a restricted parent directory and appropriate ACLs rather than making secrets public.

```sh
umask 077
mkdir -p secrets
openssl rand -hex 32 > secrets/postgres_password
openssl rand -hex 32 > secrets/auth_secret
openssl rand -hex 32 > secrets/encryption_key
printf 'postgresql://toolstile:%s@postgres:5432/toolstile\n' "$(cat secrets/postgres_password)" > secrets/database_url
# Local Compose implements file secrets as bind mounts, not an encrypted secret store.
chmod 0444 secrets/*
export BETTER_AUTH_URL=https://tools.example.com
export TOOLSTILE_IMAGE=toolstile:your-reviewed-revision
docker compose build
docker compose up -d --wait
```

`TOOLSTILE_SECRETS_DIR` may point at an absolute protected directory instead of `./secrets`. Do not replace existing secrets when upgrading. The app reads `DATABASE_URL_FILE`, `BETTER_AUTH_SECRET_FILE` and `ENCRYPTION_KEY_FILE`; setting a value and its `_FILE` counterpart together fails. A URL containing a password must percent-encode reserved characters. The database URL must reach PostgreSQL directly or through a session-mode pooler, never a transaction-mode pooler (such as PgBouncer in transaction mode): transactions hold session-level advisory locks taken before they begin and fail with a session-affinity error when their backend does not hold them. Compose does not expose PostgreSQL to the host. Its named `postgres_data` volume survives container replacement and `docker compose down`. Never use `down -v` on an installation you wish to retain.

Startup validates required configuration, runs transactional, advisory-locked migrations and starts the HTTP server only after success. Repeated migrations verify the applied migration hashes. PostgreSQL readiness precedes application startup; `/health` checks access to initialized application tables with a separate bounded database pool. `/live` checks the HTTP process without depending on PostgreSQL. Docker marks an unhealthy app but does not restart it for health failures alone; `unless-stopped` restarts exited processes. Investigate persistent unhealthy status rather than adding a restart loop around a broken database.

Create an addressed invitation explicitly:

```sh
docker compose run --rm --no-deps app bootstrap you@example.com
```

Open the private 24-hour invitation URL and create the account. Then grant instance administration:

```sh
docker compose run --rm --no-deps app operator you@example.com
```

Invitation output is a credential: do not retain it in shared logs. The admin commands require database access and are privileged operator actions. Ordinary startup never creates accounts or changes registration policy.

## HTTPS and reverse proxy

The default host binding is `127.0.0.1:3000`; terminate TLS at a host reverse proxy and firewall direct access. Set `TOOLSTILE_PORT` if another host port is needed. A containerized proxy must share a deliberate Docker network and connect to `app:3000`; its loopback is not the host's loopback. Do not expose the app on the LAN until HTTPS and access controls are configured. Match `BETTER_AUTH_URL` exactly to the externally visible origin, including a nondefault port if used.

For nginx on the host, inside your existing TLS virtual host:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Manage certificates and HTTP-to-HTTPS redirection in that proxy. Preserve methods GET/POST/DELETE, cookies, authorization, Origin, `Mcp-Session-Id`, `MCP-Protocol-Version`, `Last-Event-ID`, streaming content types and exact query bytes. Do not add caching, body rewriting, redirects or browser challenges to MCP/OAuth routes. Keep proxy timeouts above the intended SSE lifetime and test reconnect. Configure only trusted forwarding headers; this package does not add an IP-based authorization trust mechanism.

Upstream private-network access is enabled by the application's existing destination policy unless the operator restricts it. Containers can reach adjacent infrastructure. Review instance destination settings and enforce suitable host/network egress controls without bypassing URL/DNS/redirect checks. Never mount a Docker socket, host filesystem or service credentials into the app. Optional SMTP/social credentials may be supplied through your orchestrator's environment management; consult existing account configuration. No external analytics service is enabled by this package.

## Upgrade and shutdown

1. Read release/schema notes. Retain the old image and a tested manual backup with the matching auth/encryption keys and origin.
2. Build the new immutable image. Pause client traffic and stop the application: `docker compose stop app`. Keep PostgreSQL and its volume.
3. Select the new `TOOLSTILE_IMAGE`, then run `docker compose run --rm --no-deps app migrate`. A failure leaves the app stopped; inspect redacted logs and correct the cause. Do not edit applied SQL files or bypass migration hashes.
4. Run `docker compose up -d --no-deps --wait app`. Check `/health`, password sign-in, a client MCP initialize/list/call and an upstream connection. Clients reconnect after replacement; in-memory MCP sessions are not durable.

SIGTERM stops HTTP admission and maintenance scheduling, briefly drains work, closes MCP streams, waits for outstanding HTTP/maintenance work, then closes upstream and database resources. The application enforces a 25-second shutdown deadline; Compose and Kubernetes allow 35 seconds. A forced timeout can interrupt an action whose remote outcome is unknown. Do not automatically retry it; inspect the upstream system before repeating a non-idempotent operation. Set `SERVER_SHUTDOWN_TIMEOUT` only with a reviewed lifecycle budget; the image defaults to 20 seconds for HTTP draining.

There is no automatic downgrade migration. Reverting the image is safe only if that image supports the current schema. Otherwise restore a pre-upgrade database and matching keys into an isolated target, validate it, and deliberately cut over, accounting for writes since the backup. PostgreSQL major-version upgrades require PostgreSQL's own documented dump/restore or upgrade procedure, not a tag change over an existing volume.

## Manual backup, restore and recovery

These are operator-initiated backups. No scheduled backup service, remote storage or paid resource is enabled. Back up before every upgrade and rehearse restore periodically. Database copies contain credentials and personal data even though upstream secrets are encrypted.

For a simple consistent recovery point, stop app writes and take a logical custom-format dump:

```sh
umask 077
docker compose stop app
docker compose exec -T postgres pg_dump -U toolstile -d toolstile -Fc > toolstile.dump
docker compose up -d --no-deps --wait app
```

Confirm `pg_dump` exited successfully and the archive is nonempty. Store the dump, auth/encryption secret files, original database role/configuration, origin and exact image revision together in encrypted, access-controlled storage. A live `pg_dump` is transactionally consistent, but pausing writes makes the operator's recovery point explicit. Do not copy a live PostgreSQL volume directory as a logical backup. Losing `ENCRYPTION_KEY` makes existing encrypted upstream credentials unrecoverable; losing auth secrets invalidates existing signed state.

Restore first to a **new**, isolated Compose project and new volume with the same PostgreSQL major version. Supply copies of the matching secrets, set `COMPOSE_PROJECT_NAME` or `docker compose -p recovery`, choose a different `TOOLSTILE_PORT`, and start only `postgres`. Keep the original volume untouched. Restore before starting the app:

```sh
docker compose -p recovery up -d --wait postgres
docker compose -p recovery exec -T postgres pg_restore -U toolstile -d toolstile --no-owner --exit-on-error < toolstile.dump
docker compose -p recovery run --rm --no-deps app migrate
docker compose -p recovery up -d --no-deps --wait app
```

The new database must be empty; do not restore over an initialized app. Validate row counts, login and MCP with the restored keys. Keep clients disconnected from a recovery drill and avoid invoking real tools or email delivery. Before actual cutover, stop the old app so only one installation serves that origin. If storage is corrupt, retain it for investigation and restore to a separate volume. If migration or readiness fails, inspect container exit status and logs, DB connectivity/role permissions, free disk space and secret-file readability. Never regenerate keys to work around an error.

[Kubernetes](kubernetes.md) uses the same image and recovery principles with externally managed PostgreSQL.
