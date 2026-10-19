#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
unit_source="$repo_root/infrastructure/systemd/nexus-browser.service"
mission_dropin_source="$repo_root/infrastructure/systemd/nexus-mission-engine.service.d/browser-use.conf"
skill_source="$repo_root/config/agent-skills/browser-harness/SKILL.md"
browser_config_source="$repo_root/config/browser/browser.local.json"

uv tool install --python 3.12 --upgrade 'browser-harness==0.1.13'
browser-harness telemetry disable
browser-harness recordings disable

install -d -m 700 "$HOME/.config/systemd/user"
install -d -m 700 "$HOME/.config/systemd/user/nexus-mission-engine.service.d"
install -d -m 700 "$HOME/.config/browser-harness" "$HOME/.local/share/nexus/browser-profile"
install -d -m 700 "$HOME/.local/share/nexus/browser-xdg/config"
install -d -m 700 "$HOME/.local/share/nexus/browser-xdg/cache"
install -d -m 700 "$HOME/.local/share/pki"
install -d -m 700 "$HOME/.codex/skills/browser-harness" "$HOME/.claude/skills/browser-harness"
install -m 600 "$skill_source" "$HOME/.codex/skills/browser-harness/SKILL.md"
install -m 600 "$skill_source" "$HOME/.claude/skills/browser-harness/SKILL.md"
ln -sfn "$unit_source" "$HOME/.config/systemd/user/nexus-browser.service"
install -m 600 "$mission_dropin_source" "$HOME/.config/systemd/user/nexus-mission-engine.service.d/browser-use.conf"
install -d -m 700 "$repo_root/services/api/config"
install -m 600 "$browser_config_source" "$repo_root/services/api/config/browser.json"

systemctl --user daemon-reload
systemctl --user enable --now nexus-browser.service
systemctl --user try-restart nexus-mission-engine.service
systemctl --user try-restart nexus-api.service 2>/dev/null || true

BU_CDP_URL=http://127.0.0.1:19222 browser-harness <<'PY'
print(page_info())
PY
BU_CDP_URL=http://127.0.0.1:19222 browser-harness doctor --json --require-existing-daemon
