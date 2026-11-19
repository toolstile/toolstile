# Continuous integration

The workflow sets up Vite+ with `voidzero-dev/setup-vp` (Node.js 26.13.1, pnpm 11.20.0 from `packageManager`) and runs on an ephemeral Blacksmith Ubuntu 24.04 runner (4 vCPU) for pushes to main and pull requests against main. Pull-request runs use the `pull_request` event: read-only token, no secrets, and a newer push to the same pull request cancels the older run. Workflows from outside contributors wait for maintainer approval; each push to main runs on its own. It installs the frozen lockfile, checks dependencies/secrets, lint and types, builds the Node application, then runs the complete disposable PostgreSQL production HTTP suite. Fresh competing migrations and repeated application run before the nonempty suite. Failed, skipped and todo tests reject acceptance. PGlite lifecycle, backup/restore and standalone production-output regressions are part of that suite. A second job builds the single executable on Linux x64, Linux arm64 and macOS arm64 and runs `vp run test:binary` against it with an empty environment: init, invitation, sign-up and sign-in, embedded assets, MCP authentication, operator, clean shutdown, backup and restore. The executables are not uploaded.

Run locally before integrating runtime changes:

```sh
vp run security:check
vp run lint
vp run check
vp run build
vp run test:local
vp run build:binary
vp run test:binary
```

`test:local` runs `scripts/test-postgres.mjs`, which owns a Docker PostgreSQL fixture. No development server or provider credentials are required. Ctrl-C stops the run and still removes the fixture container. A bare `vp run test` is not a substitute: it skips the database/HTTP suites and ends with an `INCOMPLETE` summary naming the skipped count and this command, while `test:local` fails on any skip. Container packaging also has an explicit local acceptance command:

```sh
docker build -t toolstile:local .
TOOLSTILE_TEST_IMAGE=toolstile:local node scripts/test-container.mjs
kubectl kustomize deploy/kubernetes
```

Container acceptance owns an isolated Compose project and disposable database volume and removes only those resources. It exercises the final image; it does not publish it. Kubernetes live acceptance requires a disposable operator-owned cluster and is recorded separately from rendering. CI does not provision a cluster, deploy or publish packages, images or executables.

Any advisory fails the dependency audit unless an entry in `security-exceptions.json` accepts it: the entry names the advisory, package and installed version, every install path ends in one of its listed parents, and it states a reason and an expiry date. An expired or unexplained entry fails the audit. The current entry covers a picomatch advisory reached only through build and test tooling. Drizzle Kit's legacy esbuild-kit loader is pinned to the patched esbuild 0.25.12 through a workspace override. Secret findings print redacted rule/path metadata only.
