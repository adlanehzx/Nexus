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
ENGINE_PORT="${NEXUS_E2E_ENGINE_PORT:-18107}"
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
  stop_service engine
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

ensure_signing_key() {
  [[ -f "$STATE_DIR/signing.pem" ]] || openssl genpkey -algorithm ed25519 -out "$STATE_DIR/signing.pem" 2>/dev/null
  openssl pkey -in "$STATE_DIR/signing.pem" -pubout -out "$STATE_DIR/signing.pub.pem" 2>/dev/null
}

start_engine() {
  stop_service engine
  mkdir -p "$STATE_DIR/engine"
  [[ -f "$STATE_DIR/engine/profiles.json" ]] || echo '{"claude":"claude","codex":"codex"}' >"$STATE_DIR/engine/profiles.json"
  (
    cd "$ROOT/services/mission-engine"
    NEXUS_ENGINE_PORT="$ENGINE_PORT" NEXUS_ENGINE_DATABASE="$STATE_DIR/engine/engine.db" \
      NEXUS_ENGINE_API_PUBLIC_KEY_FILE="$STATE_DIR/signing.pub.pem" \
      NEXUS_ENGINE_PROFILES_FILE="$STATE_DIR/engine/profiles.json" \
      NEXUS_ENGINE_RUNTIME_SETTINGS_FILE="$STATE_DIR/engine/runtime-settings.json" \
      NEXUS_ENGINE_SCHEDULER_ENABLED=true NEXUS_ENGINE_WORKER_ENABLED=false \
      nohup setsid .venv/bin/nexus-mission-engine >"$STATE_DIR/engine.log" 2>&1 &
    echo $! >"$STATE_DIR/engine.pid"
  )
}

start_api() {
  stop_service api
  (
    cd "$ROOT/services/api"
    DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" API_HOST=127.0.0.1 API_PORT="$API_PORT" \
      AUTH_SIGNING_KEY="$(cat "$STATE_DIR/signing.pem")" \
      MISSION_CONTROL_URL="http://127.0.0.1:$ENGINE_PORT" \
      METRICS_ENABLED=false MEMORY_EMBEDDING_BACKEND=hash \
      NEXUS_RUNTIME_CONFIG_DIR="$STATE_DIR/runtime" NEXUS_OBSERVABILITY_DIR="$STATE_DIR/observability" \
      CORS_ORIGINS="http://127.0.0.1:$DASHBOARD_PORT" \
      NEXUS_PROBE_ENV_ALLOWLIST="${NEXUS_PROBE_ENV_ALLOWLIST:-XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_CACHE_HOME,XDG_STATE_HOME}" \
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
  ensure_signing_key
  (cd "$ROOT/services/mission-engine" && uv sync --quiet)
  start_engine
  start_api
  start_dashboard
  wait_for "http://127.0.0.1:$ENGINE_PORT/v1/health/live"
  wait_for "http://127.0.0.1:$API_PORT/health"
  wait_for "http://127.0.0.1:$DASHBOARD_PORT/"
  echo "API: http://127.0.0.1:$API_PORT  Dashboard: http://127.0.0.1:$DASHBOARD_PORT"
}

case "${1:-up}" in
  up) up ;;
  restart-engine) start_engine; wait_for "http://127.0.0.1:$ENGINE_PORT/v1/health/live" ;;
  down) down ;;
  *) echo "Usage: $0 up|down|restart-engine" >&2; exit 2 ;;
esac
