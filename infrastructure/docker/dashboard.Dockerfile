# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.25.0

FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @nexus/dashboard...
# An empty URL enables same-origin mode: nginx proxies /api and /ws without
# embedding a host name or secret in public JavaScript.
ENV VITE_NEXUS_URL=""
RUN pnpm --filter @nexus/dashboard... run build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY infrastructure/docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
