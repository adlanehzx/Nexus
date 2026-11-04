# syntax=docker/dockerfile:1
#
# API service image built from the monorepo root.
# The runtime stage contains only compiled JavaScript and production dependencies.

ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0

# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base

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
COPY packages/agent-core/package.json  packages/agent-core/
COPY packages/vcs/package.json         packages/vcs/
COPY packages/career/package.json      packages/career/
COPY packages/devices/package.json     packages/devices/
COPY packages/linkedin/package.json    packages/linkedin/
COPY packages/mission-control-client/package.json packages/mission-control-client/
COPY packages/browser-client/package.json packages/browser-client/
COPY packages/notifications/package.json packages/notifications/
COPY packages/osint/package.json       packages/osint/
COPY packages/mcp/package.json         packages/mcp/
COPY packages/web-search/package.json  packages/web-search/
COPY packages/worker-core/package.json packages/worker-core/
COPY packages/design/package.json      packages/design/
COPY packages/client-core/package.json packages/client-core/
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
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PATH=/opt/nexus-python/bin:$PATH \
    OSINT_SHERLOCK_PATH=/opt/nexus-python/bin/sherlock \
    OSINT_SHERLOCK_VERSION=0.16.2

# dumb-init forwards SIGTERM to Node for graceful shutdown. Sherlock is kept in
# its own virtual environment and pinned: it is an external MIT-licensed tool,
# not imported into NEXUS or allowed to execute arbitrary arguments.
#
# The base is Debian rather than Alpine on purpose: `onnxruntime-node`, which
# backs the `neural` memory embedding backend, ships glibc prebuilts only. On
# musl it fails to load, writing a memory answers 500, and semantic recall
# silently never works. See ADR-018.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      dumb-init git python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/nexus-python \
    && /opt/nexus-python/bin/pip install --no-cache-dir \
      "sherlock-project==0.16.2" \
      "browser-harness==0.1.13" \
    && /opt/nexus-python/bin/sherlock --version \
    && browser-harness --version
RUN mkdir -p \
      /var/lib/nexus/models \
      /var/lib/nexus/runtime-config \
      /var/lib/nexus/artifacts/browser \
      /var/lib/nexus/observability \
      /var/lib/nexus/workspaces \
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
