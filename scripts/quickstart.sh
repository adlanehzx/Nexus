#!/usr/bin/env bash
set -euo pipefail

# NEXUS Quickstart Bootstrapper
# Purpose: Initialize environment, detect host CLIs, start Docker stack, and verify readiness.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOCKER_DIR="${ROOT_DIR}/infrastructure/docker"
ENV_FILE="${DOCKER_DIR}/.env"
ENV_EXAMPLE="${DOCKER_DIR}/.env.example"

echo "=========================================================="
echo "                   NEXUS QUICKSTART                       "
echo "=========================================================="

# 1. Dependency Checks
command -v docker >/dev/null 2>&1 || { echo "[ERROR] Docker is required but not installed. Aborting."; exit 1; }

DOCKER_COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker-compose"
else
  echo "[ERROR] Docker Compose (v2 or v1) is required. Aborting."
  exit 1
fi

# 2. Environment Configuration
if [ ! -f "${ENV_FILE}" ]; then
  echo "[INFO] Creating infrastructure/docker/.env from .env.example..."
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
fi

# 3. Detect and populate host CLI paths if missing
CLAUDE_PATH="$(command -v claude 2>/dev/null || true)"
CODEX_PATH="$(command -v codex 2>/dev/null || true)"
AGY_PATH="$(command -v agy 2>/dev/null || true)"

if [ -n "${CLAUDE_PATH}" ]; then
  if ! grep -q "^CLAUDE_BIN_PATH=" "${ENV_FILE}"; then
    echo "CLAUDE_BIN_PATH=${CLAUDE_PATH}" >> "${ENV_FILE}"
    echo "[INFO] Detected Claude CLI at: ${CLAUDE_PATH}"
  fi
fi

if [ -n "${CODEX_PATH}" ]; then
  if ! grep -q "^CODEX_BIN_PATH=" "${ENV_FILE}"; then
    echo "CODEX_BIN_PATH=${CODEX_PATH}" >> "${ENV_FILE}"
    echo "[INFO] Detected Codex CLI at: ${CODEX_PATH}"
  fi
fi

if [ -n "${AGY_PATH}" ]; then
  if ! grep -q "^AGY_BIN_PATH=" "${ENV_FILE}"; then
    echo "AGY_BIN_PATH=${AGY_PATH}" >> "${ENV_FILE}"
    echo "[INFO] Detected Antigravity CLI at: ${AGY_PATH}"
  fi
fi

# 4. Generate Master Secret if needed
if grep -q "MASTER_SECRET=nexus-local-software-vault-key-32ch" "${ENV_FILE}" 2>/dev/null || ! grep -q "^MASTER_SECRET=" "${ENV_FILE}" 2>/dev/null; then
  RANDOM_SECRET="$(head -c 32 /dev/urandom | xxd -p -c 32 2>/dev/null || openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  if grep -q "^MASTER_SECRET=" "${ENV_FILE}"; then
    sed -i "s/^MASTER_SECRET=.*/MASTER_SECRET=${RANDOM_SECRET}/" "${ENV_FILE}"
  else
    echo "MASTER_SECRET=${RANDOM_SECRET}" >> "${ENV_FILE}"
  fi
  echo "[INFO] Generated secure random MASTER_SECRET."
fi

# 5. Start Container Stack
echo "[INFO] Starting NEXUS stack via Docker Compose..."
${DOCKER_COMPOSE_CMD} -f "${DOCKER_DIR}/docker-compose.yml" --env-file "${ENV_FILE}" up -d

# 6. Wait for Readiness
echo "[INFO] Waiting for API readiness at http://127.0.0.1:8080/healthz..."
READY=0
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8080/healthz >/dev/null 2>&1 || curl -sf http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

echo "=========================================================="
if [ "${READY}" -eq 1 ]; then
  echo "              NEXUS IS READY AND ONLINE                   "
  echo "=========================================================="
  echo " Web Dashboard: http://localhost:8080"
  echo " API Base URL : http://localhost:8080/api/v1"
  echo " Health Probe : http://localhost:8080/healthz"
  echo ""
  echo " First time? Open http://localhost:8080 to complete the"
  echo " setup wizard and create your local administrator account."
else
  echo " [WARNING] API healthcheck did not respond within 30s."
  echo " Check container status: ${DOCKER_COMPOSE_CMD} -f ${DOCKER_DIR}/docker-compose.yml logs"
fi
echo "=========================================================="
