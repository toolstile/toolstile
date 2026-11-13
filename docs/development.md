# Development

Use Node.js 24 and the pnpm version in `package.json`. [Vite+](https://viteplus.dev) selects both from `.node-version` and `packageManager` when its `vp env` shims are enabled; any other way of selecting those versions works too. `pnpm install` runs `vp config`, which installs a pre-commit hook that formats staged TypeScript, JavaScript and CSS with `vp fmt` (`vp staged`, configured in `vite.config.ts`); `vp hooks disable` turns it off for one clone and `VP_GIT_HOOKS=0` skips installing it. The [documentation index](README.md) separates contributor references from operator runbooks. For a persistent installation, use [local operation](local-operation.md); development task storage is disposable and has separate keys.

## Task lifecycle

Use an owned source branch and worktree; never edit a shared main checkout. Parallel tasks need separate writable checkouts and runtime resources. The runtime scripts manage env files, keys, storage and processes only; they never create or remove source worktrees, merge or start a proxy. Identity derives from the current checkout and canonical Git metadata, never from branch names. There are no worktree hooks: run setup after creating a worktree and teardown before removing it.

Run from the checkout, using Node 24 and pnpm on `PATH`:

| Event | Command | Result |
| --- | --- | --- |
| After worktree creation | `node scripts/runtime.mjs setup` | Install frozen dependencies, generate private task keys and dotenv, migrate independent PGlite storage; no server |
| Stop | `node scripts/runtime.mjs stop` | Stop verified owned processes; keep storage, keys and environment |
| Resume | `node scripts/runtime.mjs resume` | Idempotently restore dependencies and migrations with the same storage and keys; no server |
| Before source removal | `node scripts/runtime.mjs teardown` | Stop owned processes, then delete positively owned task runtime resources |
| Inspect readiness | `node scripts/runtime.mjs check` | Read-only validation; nonzero if missing, incompatible or incomplete |
| Interactive server | `node scripts/runtime.mjs dev` | Run the owned Vite dev server in the foreground until interrupted |

Verify `check` before using a prepared or resumed task, and run and verify teardown before removing the worktree. A failed cleanup retains its ownership manifest and ambiguous resources for manual recovery. Stopping never merges code.

Main-checkout operations require the explicit `--main` flag on every command, for example `node scripts/runtime.mjs setup --main` and `node scripts/runtime.mjs check --main`. They use the same resource ownership policy. Existing unowned `apps/web/.env` files are retained and setup refuses to adopt them. Back up and inspect such configuration manually before choosing a new lifecycle-owned setup; no automatic main-runtime migration is performed.

Setup writes `BETTER_AUTH_URL=http://localhost:<task port>`, a stable per-checkout port from `portStart`. `dev` listens on `PORT` and `HOST` when set (otherwise that task port, or the next free one, on `127.0.0.1`) and serves the origin in `BETTER_AUTH_URL` from the invoking shell when set, otherwise `http://localhost:$PORT`. That origin becomes the auth/OAuth origin and Vite's allowed host for the run; the generated dotenv is not rewritten. Behind a local HTTPS proxy, export its URL as `BETTER_AUTH_URL`; plain HTTP is accepted only for `localhost` and loopback hosts. Setup and resume never start a server. The default profile uses the offline bundled catalog and no external provider credentials. Use `pnpm bootstrap you@example.com` with the generated dotenv to create an invitation when needed.

Outside the task lifecycle, `pnpm dev` starts Vite with `apps/web/.env`, honouring `PORT` (default 4310) and `HOST` (default `127.0.0.1`); keep that file's `BETTER_AUTH_URL` equal to the URL you open.

## Ownership and recovery

Version-2 manifests live in the Git common directory under `toolstile-worktree-resources/task-<hash>.json`. The stable task ID hashes the canonical checkout and linked Git metadata paths, so branches with slashes and detached heads work. Each generation has a UUID, a private `data-task-<hash>` directory and an owner marker. The database path is named `data.sqlite` and the manifest records `server.kind: sqlite` for compatibility; the path is a PGlite directory. Existing storage is never converted or adopted automatically. Its PGlite directory, keys and generated dotenv are independent of main and other tasks. Records bind canonical Git paths, metadata/directory device and inode identities, generation markers, and environment identity/content hashes. Symlink/path substitution and mismatches fail closed. The dev server leads its own process group. Stop checks process-group fingerprints before signalling; interrupted launch recovery requires the saved stable fingerprint of that group leader. An intent with a live server but no proven stable identity is retained for manual inspection. Unknown groups and reused PIDs are retained. A server killed without cleanup is cleared by the next `stop` or `dev` after verification.

Repeated setup/resume preserves the generation and keys, retries frozen installation and idempotent migrations, and never starts a server. An interrupted or failed setup keeps its ownership record for retry or teardown. Initial directory reservations carry explicit progress: a still-absent reservation may retry creation or discard metadata, while a recorded directory identity permits marker preparation to retry. Unrecorded/substituted paths are retained even if their marker text matches. A running owned server must be stopped before dependency/migration changes; readiness checks do not install beneath it. Teardown can retry after adapter cleanup failure. Unknown resources and legacy ownership records are never automatically adopted or deleted. Old records remain available for read-only inspection; historical database cleanup needs a separately verified recovery procedure, not an inferred storage conversion.

The generic helper's adapter contract and read-only audit are in [local environment policy](local-environment.md). Never commit generated dotenv, keys, logs, database files or personal data.

## Validation

Run [the local CI gates](ci.md) before integration, independently of settle/removal. For a leaf source change, use `pnpm exec vitest related <changed-source-files> --run`; empty selections are not validation. Lifecycle regressions run with `pnpm exec vitest run tests/worktree-resources.test.mjs scripts/local-environment.test.mjs`. Full HTTP acceptance owns a disposable production fixture and needs neither a dev server nor provider credentials; see [verification](verification.md). UI changes also follow [design](design.md).
