#!/usr/bin/env bash
# ==============================================================================
# NEXUS Key & Secret Generator Helper
# ==============================================================================
# Generates cryptographic keys and secrets for NEXUS infrastructure on the fly:
#   - AUTH_SIGNING_KEY: Ed25519 private key in PKCS8 PEM single-line format
#   - MASTER_KEY: 256-bit (32 bytes) hex string for vault encryption
#
# Usage:
#   bash generate-keys.sh [ENV_FILE]
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ENV="${1:-$SCRIPT_DIR/.env}"

echo "==> Generating NEXUS cryptographic secrets..."

if command -v node >/dev/null 2>&1; then
  AUTH_KEY="$(node -e 'const { generateKeyPairSync } = require("crypto"); const { privateKey } = generateKeyPairSync("ed25519"); process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }).trim().replace(/\n/g, "\\n"));')"
  MASTER_KEY="$(node -e 'const crypto = require("crypto"); process.stdout.write(crypto.randomBytes(32).toString("hex"));')"
elif command -v openssl >/dev/null 2>&1; then
  RAW_AUTH_KEY="$(openssl genpkey -algorithm ed25519 2>/dev/null)"
  AUTH_KEY="$(echo "$RAW_AUTH_KEY" | sed 's/\r$//' | paste -sd '\\' - | sed 's/\\/\\n/g')"
  MASTER_KEY="$(openssl rand -hex 32)"
else
  echo "Error: Neither 'node' nor 'openssl' found in PATH. Please install one to generate cryptographic keys." >&2
  exit 1
fi

if [ -f "$TARGET_ENV" ]; then
  if grep -q "<GENERATE_WITH_OPENSSL_OR_SCRIPT>" "$TARGET_ENV"; then
    # Write cleanly via python or awk/sed to avoid multiline escape pitfalls
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const authKey = process.argv[2];
      const masterKey = process.argv[3];
      let content = fs.readFileSync(file, "utf8");
      content = content.replace(/AUTH_SIGNING_KEY=["'\''].*?["'\'']/, `AUTH_SIGNING_KEY="${authKey}"`);
      content = content.replace(/MASTER_KEY=["'\''].*?["'\'']/, `MASTER_KEY=${masterKey}`);
      content = content.replace(/MASTER_KEY=<GENERATE_WITH_OPENSSL_OR_SCRIPT>/, `MASTER_KEY=${masterKey}`);
      fs.writeFileSync(file, content, { mode: 0o600 });
    ' "$TARGET_ENV" "$AUTH_KEY" "$MASTER_KEY" 2>/dev/null || {
      # Fallback pure shell replacement if node is not available
      sed -i.bak "s|AUTH_SIGNING_KEY=.*|AUTH_SIGNING_KEY=\"$AUTH_KEY\"|" "$TARGET_ENV"
      sed -i.bak "s|MASTER_KEY=.*|MASTER_KEY=$MASTER_KEY|" "$TARGET_ENV"
      rm -f "${TARGET_ENV}.bak"
      chmod 0600 "$TARGET_ENV"
    }
    echo "==> Injected freshly generated secrets into $TARGET_ENV (mode 0600)."
  else
    echo "==> $TARGET_ENV already contains configured secrets."
    echo "==> To regenerate or rotate, update $TARGET_ENV directly or delete it first."
    echo ""
    echo "Generated values:"
    echo "AUTH_SIGNING_KEY=\"$AUTH_KEY\""
    echo "MASTER_KEY=$MASTER_KEY"
  fi
else
  cat > "$TARGET_ENV" <<EOF
AUTH_SIGNING_KEY="$AUTH_KEY"
MASTER_KEY=$MASTER_KEY
EOF
  chmod 0600 "$TARGET_ENV"
  echo "==> Created $TARGET_ENV with secure random keys (mode 0600)."
fi

echo "==> Secret generation complete."
