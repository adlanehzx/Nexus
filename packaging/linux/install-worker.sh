#!/usr/bin/env sh
set -eu

# Installe un worker NEXUS conteneurisé sur Linux, NAS et Raspberry Pi.
# Le ticket n'est jamais écrit : il est seulement transmis au processus
# d'appairage, puis le conteneur définitif ne reçoit que l'identité locale.

IMAGE="${NEXUS_WORKER_IMAGE:-ghcr.io/adlanehzx/nexus/worker:latest}"
DATA_DIR="${NEXUS_WORKER_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/nexus-worker}"
WORKSPACE="${NEXUS_WORKSPACE:-$HOME/NEXUS}"
NAME="${NEXUS_WORKER_NAME:-$(hostname)}"

usage() {
  echo "Usage: $0 <URL_NEXUS> <TICKET> [DOSSIER_AUTORISE]" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
API_URL="$1"
PAIRING_TOKEN="$2"
[ "$#" -lt 3 ] || WORKSPACE="$3"

command -v docker >/dev/null 2>&1 || {
  echo "Docker est requis sur cette machine." >&2
  exit 1
}

mkdir -p "$DATA_DIR" "$WORKSPACE"
chmod 700 "$DATA_DIR"

# Une politique explicite évite qu'un changement de HOME dans l'image fasse
# chercher un autre fichier et donne l'impression que le worker est cassé.
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
  echo "Une identité NEXUS existe déjà dans $DATA_DIR ; rien n'a été remplacé." >&2
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
echo "Worker installé. Approuvez '$NAME' dans NEXUS > Appareils."
echo "Dossier accessible au worker : $WORKSPACE"
