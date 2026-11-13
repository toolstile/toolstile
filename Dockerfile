# syntax=docker/dockerfile:1
FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS node

FROM node AS base
# The image has no Git, so the install must not set up the Vite+ commit hooks.
ENV VP_GIT_HOOKS=0
WORKDIR /source
RUN corepack enable && corepack install -g pnpm@11.20.0

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm --dir . fetch

# Workspace manifests only, so the install stays cached across source-only changes.
FROM base AS manifests
COPY . /tmp/source
RUN cd /tmp/source && for file in package.json pnpm-lock.yaml pnpm-workspace.yaml packages/*/package.json apps/*/package.json; do \
      mkdir -p "/source/$(dirname "$file")" && cp "$file" "/source/$file"; done

FROM fetch AS build
COPY --from=manifests /source ./
RUN pnpm --dir . install --offline --frozen-lockfile
COPY . .
RUN pnpm --dir . build
RUN pnpm --dir . exec esbuild apps/web/scripts/container-admin.ts --bundle --platform=node --format=esm --target=node24 --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' --outfile=commands/admin.mjs

FROM node AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 SERVER_SHUTDOWN_TIMEOUT=20
WORKDIR /app
COPY --chown=node:node LICENSE NOTICE ./
COPY --from=build --chown=node:node /source/apps/web/.output/ .output/
COPY --from=build --chown=node:node /source/commands/ commands/
COPY --from=build --chown=node:node /source/apps/web/postgres-migrations/ postgres-migrations/
COPY --chown=node:node --chmod=0555 deploy/container/entrypoint.sh /app/entrypoint.sh
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["serve"]
