#!/usr/bin/env bash
# Starts a real NEXUS API and dashboard on disposable PostgreSQL and Redis.
# Never reuses the containers of an existing installation.
#
#   scripts/e2e-stack.sh up    # creates the containers, migrates, starts both services
#   scripts/e2e-stack.sh down  # stops the services and removes the containers
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${NEXUS_E2E_STATE_DIR:-/tmp/nexus-e2e-stack}"
API_PORT="${NEXUS_E2E_API_PORT:-3107}"
DASHBOARD_PORT="${NEXUS_E2E_DASHBOARD_PORT:-5277}"
PG=nexus-integration-pg
REDIS=nexus-integration-redis
PG_PASSWORD=nexus-test

published_port() { docker port "$1" "$2" | head -1 | sed 's/.*://'; }

stop_service() {
  local file="$STATE_DIR/$1.pid"
  [[ -f "$file" ]] || return 0
  kill "$(cat "$file")" 2>/dev/null || true
  rm -f "$file"
}

down() {
  stop_service api
  stop_service dashboard
  docker rm -f "$PG" "$REDIS" >/dev/null 2>&1 || true
}

ensure_container() {
  local name="$1"
  shift
  if ! docker inspect "$name" >/dev/null 2>&1; then
    docker run -d --name "$name" "$@" >/dev/null
  else
    docker start "$name" >/dev/null
  fi
}

start_api() {
  stop_service api
  (
    cd "$ROOT/services/api"
    DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" API_HOST=127.0.0.1 API_PORT="$API_PORT" \
      METRICS_ENABLED=false MEMORY_EMBEDDING_BACKEND=hash \
      NEXUS_RUNTIME_CONFIG_DIR="$STATE_DIR/runtime" NEXUS_OBSERVABILITY_DIR="$STATE_DIR/observability" \
      CORS_ORIGINS="http://127.0.0.1:$DASHBOARD_PORT" \
      nohup setsid ./node_modules/.bin/tsx src/server.ts >"$STATE_DIR/api.log" 2>&1 &
    echo $! >"$STATE_DIR/api.pid"
  )
}

start_dashboard() {
  stop_service dashboard
  (
    cd "$ROOT/apps/dashboard"
    VITE_NEXUS_URL="http://127.0.0.1:$API_PORT" \
      nohup setsid ./node_modules/.bin/vite --host 127.0.0.1 --port "$DASHBOARD_PORT" \
      >"$STATE_DIR/dashboard.log" 2>&1 &
    echo $! >"$STATE_DIR/dashboard.pid"
  )
}

wait_for() {
  for _ in $(seq 1 60); do
    curl -fsS -m 2 -o /dev/null "$1" && return 0
    sleep 1
  done
  echo "Timed out waiting for $1" >&2
  return 1
}

up() {
  mkdir -p "$STATE_DIR"
  ensure_container "$PG" -e "POSTGRES_PASSWORD=$PG_PASSWORD" -p 127.0.0.1::5432 pgvector/pgvector:pg17
  ensure_container "$REDIS" -p 127.0.0.1::6379 redis:7-alpine
  until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
  DATABASE_URL="postgresql://postgres:$PG_PASSWORD@127.0.0.1:$(published_port "$PG" 5432/tcp)/postgres"
  REDIS_URL="redis://127.0.0.1:$(published_port "$REDIS" 6379/tcp)"
  (cd "$ROOT" && DATABASE_URL="$DATABASE_URL" pnpm --filter @nexus/database exec prisma migrate deploy >"$STATE_DIR/migrate.log" 2>&1)
  start_api
  start_dashboard
  wait_for "http://127.0.0.1:$API_PORT/health"
  wait_for "http://127.0.0.1:$DASHBOARD_PORT/"
  echo "API: http://127.0.0.1:$API_PORT  Dashboard: http://127.0.0.1:$DASHBOARD_PORT"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  *) echo "Usage: $0 up|down" >&2; exit 2 ;;
esac
