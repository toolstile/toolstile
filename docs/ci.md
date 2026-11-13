# Continuous integration

The pinned Node.js 24.17.0 / pnpm 11.20.0 workflow runs on an ephemeral Blacksmith Ubuntu 24.04 runner (4 vCPU) for pushes to main and pull requests against main. Pull-request runs use the `pull_request` event: read-only token, no secrets, and a newer push to the same pull request cancels the older run. Workflows from outside contributors wait for maintainer approval; each push to main runs on its own. It installs the frozen lockfile, checks dependencies/secrets, lint and types, builds the Node application, then runs the complete disposable PostgreSQL production HTTP suite. Fresh competing migrations and repeated application run before the nonempty suite. Failed, skipped and todo tests reject acceptance. PGlite lifecycle, backup/restore and standalone production-output regressions are part of that suite.

Run locally before integrating runtime changes:

```sh
pnpm security:check
pnpm lint
pnpm check
pnpm build
pnpm test:local
```

`test:local` runs `scripts/test-postgres.mjs`, which owns a Docker PostgreSQL fixture. No development server or provider credentials are required. Ctrl-C stops the run and still removes the fixture container. A bare `pnpm test` is not a substitute: it skips the database/HTTP suites and ends with an `INCOMPLETE` summary naming the skipped count and this command, while `test:local` fails on any skip. Container packaging also has an explicit local acceptance command:

```sh
docker build -t toolstile:local .
TOOLSTILE_TEST_IMAGE=toolstile:local node scripts/test-container.mjs
kubectl kustomize deploy/kubernetes
```

Container acceptance owns an isolated Compose project and disposable database volume and removes only those resources. It exercises the final image; it does not publish it. Kubernetes live acceptance requires a disposable operator-owned cluster and is recorded separately from rendering. CI does not provision a cluster, deploy or publish packages or images.

The dependency advisory exception for Drizzle Kit's optional esbuild 0.18.20 loader expires 2026-12-01; it is used for transforms, not a development server. Re-review or remove it by that date. Secret findings print redacted rule/path metadata only.
