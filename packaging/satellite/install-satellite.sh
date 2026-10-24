#!/usr/bin/env bash
# ==============================================================================
# NEXUS Raspberry Pi Voice-Satellite Installer
# ==============================================================================
# Sets up a lightweight, isolated voice satellite worker on Raspberry Pi OS.
# Enforces:
#   - Single-use pairing token read strictly via STDIN (never argv / ps / logs)
#   - Dedicated unprivileged system user (nexus-satellite)
#   - Systemd hardened service with physical LED privacy state indicator hook
#   - Full clean uninstallation support (--uninstall)
# ==============================================================================
set -euo pipefail

INSTALL_DIR="/opt/nexus-satellite"
CONFIG_DIR="/etc/nexus-satellite"
SERVICE_NAME="nexus-voice-satellite.service"
USER_NAME="nexus-satellite"

usage() {
  cat <<EOF
Usage:
  sudo bash install-satellite.sh --token-stdin [OPTIONS]
  sudo bash install-satellite.sh --uninstall

Options:
  --server-url URL    NEXUS server URL (default: http://127.0.0.1:3000)
  --device-name NAME  Device name (default: Raspberry Pi Satellite)
  --token-stdin       Read pairing token from stdin (required for non-interactive)
  --gpio-led PIN      GPIO pin for physical privacy LED indicator (default: 17)
  --uninstall         Cleanly remove service, config, and installation
  -h, --help          Show this message
EOF
  exit 1
}

uninstall() {
  echo "==> Uninstalling NEXUS Voice Satellite..."
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    systemctl stop "$SERVICE_NAME"
  fi
  if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl disable "$SERVICE_NAME"
  fi
  rm -f "/etc/systemd/system/$SERVICE_NAME"
  systemctl daemon-reload

  rm -rf "$INSTALL_DIR"
  rm -rf "$CONFIG_DIR"

  if id "$USER_NAME" &>/dev/null; then
    userdel "$USER_NAME" || true
  fi

  echo "==> NEXUS Voice Satellite uninstalled cleanly."
  exit 0
}

# Parse options
SERVER_URL="http://127.0.0.1:3000"
DEVICE_NAME="Raspberry Pi Satellite"
TOKEN_STDIN=false
GPIO_LED=17
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url)
      SERVER_URL="$2"
      shift 2
      ;;
    --device-name)
      DEVICE_NAME="$2"
      shift 2
      ;;
    --token-stdin)
      TOKEN_STDIN=true
      shift
      ;;
    --gpio-led)
      GPIO_LED="$2"
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
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ "$UNINSTALL" == true ]]; then
  uninstall
fi

echo "==> Installing NEXUS Voice Satellite Worker on Raspberry Pi OS..."

# 1. Read token strictly via stdin or hidden prompt (NEVER in argv)
PAIRING_TOKEN=""
if [[ "$TOKEN_STDIN" == true ]]; then
  read -r PAIRING_TOKEN
else
  read -s -p "Enter single-use pairing token: " PAIRING_TOKEN
  echo ""
fi

if [[ -z "$PAIRING_TOKEN" ]]; then
  echo "Error: Pairing token is mandatory and cannot be empty." >&2
  exit 1
fi

# 2. Create isolated system user
if ! id "$USER_NAME" &>/dev/null; then
  echo "Creating isolated service user: $USER_NAME"
  useradd --system --shell /usr/sbin/nologin --home-dir "$INSTALL_DIR" "$USER_NAME"
  # Add to audio group for ALSA/PulseAudio access, and gpio if present
  usermod -aG audio "$USER_NAME" || true
  if getent group gpio >/dev/null; then
    usermod -aG gpio "$USER_NAME" || true
  fi
fi

# 3. Create restricted directories (0700 mode)
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
chmod 0700 "$CONFIG_DIR" "$INSTALL_DIR"
chown -R "$USER_NAME:$USER_NAME" "$CONFIG_DIR" "$INSTALL_DIR"

# 4. Write satellite configuration
CONFIG_FILE="$CONFIG_DIR/satellite.json"
cat > "$CONFIG_FILE" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "deviceName": "$DEVICE_NAME",
  "deviceType": "LINUX",
  "capabilities": ["voice.playback", "voice.record", "camera.capture", "sensor.temperature"],
  "gpioPrivacyLedPin": $GPIO_LED,
  "hardwarePrivacyIndicator": true,
  "audioSampleRate": 16000,
  "channels": 1,
  "zeroRetentionAudio": true
}
EOF
chmod 0600 "$CONFIG_FILE"
chown "$USER_NAME:$USER_NAME" "$CONFIG_FILE"

# Store ephemeral pairing token in temporary file for initial pairing exchange
TOKEN_FILE="$CONFIG_DIR/pairing-ticket.key"
printf "%s" "$PAIRING_TOKEN" > "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"
chown "$USER_NAME:$USER_NAME" "$TOKEN_FILE"

# 5. Create privacy LED hook script
LED_HOOK="$INSTALL_DIR/privacy-led.sh"
cat > "$LED_HOOK" <<'EOF'
#!/bin/sh
STATE="$1" # "recording", "idle", or "off"
PIN=17
if [ -d /sys/class/gpio ]; then
  if [ ! -d "/sys/class/gpio/gpio$PIN" ]; then
    echo "$PIN" > /sys/class/gpio/export 2>/dev/null || true
    echo "out" > "/sys/class/gpio/gpio$PIN/direction" 2>/dev/null || true
  fi
  case "$STATE" in
    recording) echo 1 > "/sys/class/gpio/gpio$PIN/value" 2>/dev/null || true ;;
    *) echo 0 > "/sys/class/gpio/gpio$PIN/value" 2>/dev/null || true ;;
  esac
fi
EOF
chmod 0755 "$LED_HOOK"
chown "$USER_NAME:$USER_NAME" "$LED_HOOK"

# 6. Install hardened systemd unit file
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=NEXUS Voice Satellite Worker
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=-/etc/default/nexus-voice-satellite
ExecStart=/usr/bin/env node --no-warnings /opt/nexus-satellite/worker.js --config $CONFIG_FILE
Restart=on-failure
RestartSec=5s

# Security Hardening
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadWritePaths=$CONFIG_DIR $INSTALL_DIR

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 "$UNIT_FILE"
systemctl daemon-reload
echo "==> Service $SERVICE_NAME installed successfully."
echo "==> Enable with: sudo systemctl enable --now $SERVICE_NAME"
echo "==> Physical LED indicator configured on GPIO $GPIO_LED."
EOF
