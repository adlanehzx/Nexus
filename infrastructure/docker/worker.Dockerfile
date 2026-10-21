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
    pnpm install --frozen-lockfile --filter @nexus/windows-worker...
RUN pnpm --filter @nexus/windows-worker... run build
RUN pnpm --filter @nexus/windows-worker deploy --prod --legacy /worker

FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache git tini
ENV HOME=/home/node \
    WORKER_POLICY_FILE=/var/lib/nexus/device-policy.yaml
WORKDIR /opt/nexus-worker
COPY --from=builder /worker ./
RUN mkdir -p /var/lib/nexus /workspace && chown -R node:node /var/lib/nexus /workspace
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--env-file-if-exists=/var/lib/nexus/worker.env", "dist/main.js"]
