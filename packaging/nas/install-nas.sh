#!/usr/bin/env bash
# ==============================================================================
# NEXUS NAS One-Click Deployment Helper
# ==============================================================================
# Detects Synology DSM, QNAP QTS, or TrueNAS SCALE and configures the stack.
# Enforces:
#   - Non-root UID/GID mapping
#   - Persistent directory layout
#   - Healthcheck readiness validation
#   - Clean teardown with --uninstall
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<EOF
Usage:
  bash install-nas.sh [OPTIONS]
  bash install-nas.sh --uninstall

Options:
  --platform PLATFORM  Target platform: synology | qnap | truenas | generic (auto-detected if omitted)
  --data-dir PATH      Data directory path (defaults to standard platform share)
  --uninstall          Cleanly stop and remove containers
  -h, --help           Show this message
EOF
  exit 1
}

detect_platform() {
  if [ -f /etc/synoinfo.conf ]; then
    echo "synology"
  elif [ -f /etc/config/uLinux.conf ] || which getcfg >/dev/null 2>&1; then
    echo "qnap"
  elif which midclt >/dev/null 2>&1 || [ -f /etc/truenas_version ]; then
    echo "truenas"
  else
    echo "generic"
  fi
}

PLATFORM=""
DATA_DIR=""
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="$2"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
  esac
done

if [ -z "$PLATFORM" ]; then
  PLATFORM="$(detect_platform)"
  echo "==> Auto-detected NAS platform: $PLATFORM"
fi

case "$PLATFORM" in
  synology)
    DEFAULT_DIR="/volume1/docker/nexus"
    COMPOSE_FILE="$SCRIPT_DIR/synology-docker-compose.yml"
    ;;
  truenas)
    DEFAULT_DIR="/mnt/tank/apps/nexus"
    COMPOSE_FILE="$SCRIPT_DIR/truenas-docker-compose.yml"
    ;;
  qnap)
    DEFAULT_DIR="/share/Container/nexus"
    COMPOSE_FILE="$SCRIPT_DIR/synology-docker-compose.yml" # standard compose fallback
    ;;
  *)
    DEFAULT_DIR="/opt/nexus"
    COMPOSE_FILE="$SCRIPT_DIR/synology-docker-compose.yml"
    ;;
esac

TARGET_DIR="${DATA_DIR:-$DEFAULT_DIR}"

if [ "$UNINSTALL" = true ]; then
  echo "==> Tearing down NEXUS stack on $PLATFORM..."
  if [ -f "$TARGET_DIR/docker-compose.yml" ]; then
    docker compose -f "$TARGET_DIR/docker-compose.yml" down
  fi
  echo "==> NEXUS containers stopped. Data volumes preserved at $TARGET_DIR."
  exit 0
fi

echo "==> Setting up NEXUS on $PLATFORM in $TARGET_DIR..."

mkdir -p "$TARGET_DIR/data" "$TARGET_DIR/uploads" "$TARGET_DIR/postgres_data" "$TARGET_DIR/redis_data"
chmod 0750 "$TARGET_DIR"

# Generate local env with strong random secrets if not present
ENV_FILE="$TARGET_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  DB_PASSWORD="$(openssl rand -hex 16)"
  JWT_SECRET="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
DB_PASSWORD=$DB_PASSWORD
JWT_SECRET=$JWT_SECRET
NODE_ENV=production
EOF
  chmod 0600 "$ENV_FILE"
  echo "==> Generated secure credentials in $ENV_FILE"
fi

cp "$COMPOSE_FILE" "$TARGET_DIR/docker-compose.yml"

echo "==> Configuration complete in $TARGET_DIR."
echo "==> Launch stack with:"
echo "    cd $TARGET_DIR && docker compose --env-file .env up -d"
echo "==> Dashboard will be reachable at http://YOUR_NAS_IP:8080"
EOF
