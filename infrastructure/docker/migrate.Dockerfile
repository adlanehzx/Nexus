# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0
FROM node:${NODE_VERSION}-alpine
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @nexus/database...
COPY packages/database/prisma packages/database/prisma
COPY packages/database/prisma.config.ts packages/database/prisma.config.ts
ENV NODE_ENV=production
USER node
CMD ["pnpm", "--dir", "packages/database", "migrate:deploy"]
