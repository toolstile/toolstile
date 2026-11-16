# Contributing

Report bugs and request features with [GitHub Issues](https://github.com/toolstile/toolstile/issues/new/choose). Email account and billing questions to support@toolstile.com, and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Setup

Install [Vite+](https://viteplus.dev) (`vp`); it runs Node.js 24 and the pnpm version pinned in `package.json`. Use `vp install` and `vp run <script>` rather than calling pnpm directly. Development uses embedded PGlite (PostgreSQL in the Node process) and independent local keys; no external database or container runtime is required. Follow [development](docs/development.md) for task preparation, interactive startup and cleanup. For running a persistent standalone instance, follow [local operation](docs/local-operation.md).

## Checks

Run the [local CI gates](docs/ci.md) before integration; `vp run test:local` needs Docker for its disposable PostgreSQL. [Verification](docs/verification.md) describes focused checks, the disposable production HTTP fixture and coverage limits. Tests need neither a running development server nor provider credentials; direct Vitest runs may skip integration suites and do not establish complete acceptance.

## Layout

- `apps/web`: the TanStack Start application, server runtime, migrations and scripts
- `packages/*`: `api`, `auth`, `database`, `gateway` and `ui`; see [docs/packages.md](docs/packages.md)
- `tests/`: integration and protocol suites with local fixtures

## Commits

Write a short imperative subject that says what changed and why (for example, "Return 404 for root OAuth protected-resource metadata"). Sign off each commit with `git commit -s`; the Developer Certificate of Origin is at https://developercertificate.org/. By signing off, you certify that you have the right to contribute the work under Apache-2.0. Include evidence for user isolation and permission enforcement when changing server behavior.

Never include tokens, upstream credentials, private user activity or `.env` files in a contribution.
