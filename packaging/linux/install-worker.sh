#!/usr/bin/env sh
set -eu

# Installs a containerized NEXUS worker on Linux, NAS, and Raspberry Pi.
# The token is never persisted to disk: it is passed solely to the pairing
# process, after which the final container receives only its local identity.

IMAGE="${NEXUS_WORKER_IMAGE:-ghcr.io/adlanehzx/nexus/worker:latest}"
DATA_DIR="${NEXUS_WORKER_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/nexus-worker}"
WORKSPACE="${NEXUS_WORKSPACE:-$HOME/NEXUS}"
NAME="${NEXUS_WORKER_NAME:-$(hostname)}"

usage() {
  echo "Usage: printf '%s' \"\$TOKEN\" | $0 <NEXUS_URL> [ALLOWED_WORKSPACE]" >&2
  echo "   or: $0 <NEXUS_URL> --token-stdin [ALLOWED_WORKSPACE]" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
API_URL="$1"

if [ "${2:-}" = "--token-stdin" ] || [ "$#" -eq 1 ]; then
  if [ -t 0 ]; then
    printf 'Enter pairing token: ' >&2
    stty -echo 2>/dev/null || true
    read -r PAIRING_TOKEN
    stty echo 2>/dev/null || true
    printf '\n' >&2
  else
    PAIRING_TOKEN="$(cat)"
  fi
  if [ "$#" -ge 3 ] && [ "${2:-}" = "--token-stdin" ]; then
    WORKSPACE="$3"
  elif [ "$#" -ge 2 ] && [ "${2:-}" != "--token-stdin" ]; then
    WORKSPACE="$2"
  fi
elif [ "$#" -ge 2 ]; then
  PAIRING_TOKEN="$2"
  [ "$#" -lt 3 ] || WORKSPACE="$3"
  echo "Notice: Passing tokens on command-line arguments can expose secrets to other local users via ps. Prefer piping via stdin: printf '%s' \"\$TOKEN\" | $0 $API_URL" >&2
else
  usage
fi

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required on this machine." >&2
  exit 1
}

mkdir -p "$DATA_DIR" "$WORKSPACE"
chmod 700 "$DATA_DIR"

# An explicit policy prevents a HOME change inside the image from looking up
# a different file and giving the impression that the worker is broken.
if [ ! -e "$DATA_DIR/device-policy.yaml" ]; then
  cat > "$DATA_DIR/device-policy.yaml" <<'POLICY'
version: 1
filesystem:
  allow: [/workspace]
  deny:
    under: []
    segments: [.ssh, .gnupg]
    names: [id_rsa, id_ed25519]
exec:
  mode: allowlist
  allowedExecutables: [git, node]
  allowedEnv: [PATH, HOME, TMPDIR]
git:
  allowWrite: false
docker:
  allowedSubcommands: []
network:
  egress: deny
POLICY
  chmod 600 "$DATA_DIR/device-policy.yaml"
fi

if [ -e "$DATA_DIR/worker.env" ] || [ -e "$DATA_DIR/device.key" ]; then
  echo "A NEXUS identity already exists in $DATA_DIR; nothing was replaced." >&2
  exit 1
fi

docker pull "$IMAGE"
printf '%s' "$PAIRING_TOKEN" | docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network bridge \
  -v "$DATA_DIR:/var/lib/nexus" \
  "$IMAGE" node dist/pair.js \
    --api-url "$API_URL" \
    --token-stdin \
    --name "$NAME" \
    --platform LINUX \
    --key-path /var/lib/nexus/device.key \
    --env-path /var/lib/nexus/worker.env \
    --allowed-paths /workspace

docker rm -f nexus-worker >/dev/null 2>&1 || true
docker run -d \
  --name nexus-worker \
  --user "$(id -u):$(id -g)" \
  --restart unless-stopped \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -v "$DATA_DIR:/var/lib/nexus:ro" \
  -v "$WORKSPACE:/workspace" \
  "$IMAGE"

unset PAIRING_TOKEN
echo "Worker installed. Approve '$NAME' in NEXUS > Devices."
echo "Directory accessible to worker: $WORKSPACE"
