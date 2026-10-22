# syntax=docker/dockerfile:1
#
# API service image built from the monorepo root.
# The runtime stage contains only compiled JavaScript and production dependencies.

ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0

# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base

ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /repo

# ─────────────────────────────────────────────────────────────────────────────
# Dependencies: cached until manifests change.
FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json      packages/shared/
COPY packages/connections/package.json packages/connections/
COPY packages/config/package.json      packages/config/
COPY packages/protocol/package.json    packages/protocol/
COPY packages/auth/package.json        packages/auth/
COPY packages/database/package.json    packages/database/
COPY packages/llm/package.json         packages/llm/
COPY packages/memory/package.json      packages/memory/
COPY packages/tools/package.json       packages/tools/
COPY services/api/package.json         services/api/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @nexus/api...

# ─────────────────────────────────────────────────────────────────────────────
# Build: generate the Prisma client and compile TypeScript.
FROM deps AS builder

COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY services/api/ services/api/

RUN pnpm --filter @nexus/api... run build

# `pnpm deploy` produces a standalone production tree.
RUN pnpm --filter @nexus/api --prod deploy --legacy /out

# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

ENV NODE_ENV=production

# dumb-init forwards SIGTERM to Node for graceful shutdown.
RUN apk add --no-cache dumb-init
RUN mkdir -p \
      /var/lib/nexus/models \
      /var/lib/nexus/runtime-config \
      /var/lib/nexus/artifacts/browser \
      /var/lib/nexus/observability \
    && chown -R node:node /var/lib/nexus

WORKDIR /app
COPY --from=builder --chown=node:node /out ./

USER node
EXPOSE 3000

# Liveness must not depend on PostgreSQL or restart a healthy API when the database slows down.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
