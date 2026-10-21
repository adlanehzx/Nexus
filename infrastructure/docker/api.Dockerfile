# syntax=docker/dockerfile:1
#
# Image du service API.
# Contexte de build : la racine du monorepo (cf. docker-compose.yml).
#
# Trois étapes : dépendances → build → runtime. La dernière ne contient que le
# JavaScript compilé et les dépendances de production — ni sources TypeScript,
# ni outils de build, ni devDependencies.

ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0

# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base

ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /repo

# ─────────────────────────────────────────────────────────────────────────────
# Dépendances — couche mise en cache tant que les manifestes ne changent pas.
FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json      packages/shared/
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
# Build — génère le client Prisma puis compile le TypeScript.
FROM deps AS builder

COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY services/api/ services/api/

RUN pnpm --filter @nexus/api... run build

# `pnpm deploy` produit une arborescence autonome : le paquet, ses dépendances
# d'espace de travail réduites à leurs `files` publiés, et les seules
# dépendances de production.
RUN pnpm --filter @nexus/api --prod deploy --legacy /out

# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

ENV NODE_ENV=production

# `dumb-init` fait office de PID 1 : il transmet SIGTERM au processus Node, ce
# dont dépend l'arrêt gracieux.
RUN apk add --no-cache dumb-init
RUN mkdir -p /var/lib/nexus/models && chown -R node:node /var/lib/nexus

WORKDIR /app
COPY --from=builder --chown=node:node /out ./

USER node
EXPOSE 3000

# La sonde interroge la liveness : elle ne doit pas dépendre de PostgreSQL, sous
# peine de faire redémarrer un conteneur sain quand la base ralentit.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
