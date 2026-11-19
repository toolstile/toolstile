# syntax=docker/dockerfile:1
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS node

# Vite+ builds the application: its digest-pinned image provides vp, which installs the
# pinned Node.js and the pnpm from packageManager. The image's vp user owns /app.
FROM ghcr.io/voidzero-dev/vite-plus:1.5.1@sha256:068d824d8d8184c39defc266795d3ade452bfc5266603d25d81aeeedbedf8973 AS base
# The image has no Git, so the install must not set up the Vite+ commit hooks.
ENV VP_GIT_HOOKS=0 VP_NODE_VERSION=26.13.1
WORKDIR /app

# Workspace manifests only, so the install stays cached across source-only changes.
FROM base AS manifests
COPY --chown=vp:vp . /tmp/source
RUN cd /tmp/source && for file in .node-version package.json pnpm-lock.yaml pnpm-workspace.yaml packages/*/package.json apps/*/package.json; do \
      mkdir -p "/app/$(dirname "$file")" && cp "$file" "/app/$file"; done

FROM base AS build
COPY --from=manifests --chown=vp:vp /app ./
RUN vp install --frozen-lockfile
COPY --chown=vp:vp . .
RUN vp run build
RUN vp exec esbuild apps/web/scripts/container-admin.ts --bundle --platform=node --format=esm --target=node26 --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' --outfile=commands/admin.mjs

FROM node AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 SERVER_SHUTDOWN_TIMEOUT=20
WORKDIR /app
COPY --chown=node:node LICENSE NOTICE ./
COPY --from=build --chown=node:node /app/apps/web/.output/ .output/
COPY --from=build --chown=node:node /app/commands/ commands/
COPY --from=build --chown=node:node /app/apps/web/postgres-migrations/ postgres-migrations/
COPY --chown=node:node --chmod=0555 deploy/container/entrypoint.sh /app/entrypoint.sh
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["serve"]
