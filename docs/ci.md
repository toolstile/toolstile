# Continuous integration

The workflow sets up Vite+ with `voidzero-dev/setup-vp` (Node.js 26.13.1, pnpm 11.20.0 from `packageManager`) and runs on an ephemeral Blacksmith Ubuntu 24.04 runner (4 vCPU) for pushes to main and pull requests against main. Pull-request runs use the `pull_request` event: read-only token, no secrets, and a newer push to the same pull request cancels the older run. Workflows from outside contributors wait for maintainer approval; each push to main runs on its own. It installs the frozen lockfile, checks dependencies/secrets, lint and types, builds the Node application, then runs the complete disposable PostgreSQL production HTTP suite. Fresh competing migrations and repeated application run before the nonempty suite. Failed, skipped and todo tests reject acceptance. PGlite lifecycle, backup/restore and standalone production-output regressions are part of that suite. A second job builds the single executable on Linux x64, Linux arm64 and macOS arm64 and runs `vp run test:binary` against it with an empty environment: init, the printed one-time setup link and its operator account, foreign `Host` refusal, invitation, sign-up and sign-in, embedded assets, MCP authentication, operator, clean shutdown, backup and restore. The CI executables are not uploaded; only the release workflow below publishes them.

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

Container acceptance owns an isolated Compose project and disposable database volume and removes only those resources. It exercises the final image; it does not publish it. Kubernetes live acceptance requires a disposable operator-owned cluster and is recorded separately from rendering. CI does not provision a cluster, deploy or publish packages or images.

## Releases

`.github/workflows/release.yml` runs only when a `v*` tag is pushed. It is the one workflow that publishes anything, and it publishes only the single executables to a draft GitHub release:

1. It fails unless the tag is `v` followed by the `version` in the root `package.json`.
2. On the same three runners, Node.js and Vite+ pins as the CI executable job, it builds from the tagged commit with `TOOLSTILE_VERSION` set to that version and `vp run build:binary --compress`, then runs `vp run test:binary`, which also checks that `toolstile-server version` prints that version.
3. It records a GitHub build provenance attestation for each `toolstile-server-<os>-<arch>.br` (`actions/attest-build-provenance`).
4. A final job creates a draft release for the tag (`gh release create --draft --verify-tag`) with six files: `toolstile-server-darwin-arm64`, `toolstile-server-linux-arm64` and `toolstile-server-linux-x64`, each as `.br` (Brotli) and `.sha256` (`<hex digest>  <executable name>`, the digest of the decompressed executable). These are the names `npx toolstile server` downloads from `releases/latest/download/` or `releases/download/<tag>/`.

Build jobs have read-only contents permission plus the OIDC and attestation permissions the attestation needs; only the release job can write contents. A maintainer writes the release notes and publishes the draft by hand; `latest` downloads start only then. To release, raise the root `package.json` version, merge it, then push the matching tag from main. If a run fails after creating the draft, delete the draft before rerunning it. No npm packages or container images are published.

Any advisory fails the dependency audit unless an entry in `security-exceptions.json` accepts it: the entry names the advisory, package and installed version, every install path ends in one of its listed parents, and it states a reason and an expiry date. An expired or unexplained entry fails the audit. The current entry covers a picomatch advisory reached only through build and test tooling. Drizzle Kit's legacy esbuild-kit loader is pinned to the patched esbuild 0.25.12 through a workspace override. Secret findings print redacted rule/path metadata only.
