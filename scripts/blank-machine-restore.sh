#!/usr/bin/env bash
#
# Priority 0 success criterion: reinstall NEXUS on a blank machine and
# recover its missions, conversations, and agents.
#
# Two stages:
#
#   A. A *source* installation is seeded — user account, conversation with
#      messages, agent profiles, mission in engine database — then backed up.
#      It is **synthetic**: a directory containing only what the backup reads.
#      Never the current repo: writing into the live engine database to create
#      a test dataset would be unacceptable; this is what `--root` is for.
#
#   B. A *blank* installation is created via `git archive`: no `.env`,
#      no `dist`, no `var`, no backup. Full setup is executed — dependencies,
#      build, `nexus setup`, migrations — then restored and verified.
#
# The archive extraction gives the test its value. Reusing the current directory
# while deleting a few files would leave lingering artifacts, which is precisely
# what we want to prove absent.
#
#   DATABASE_PASSWORD=... scripts/blank-machine-restore.sh

set -euo pipefail

HOST="${DATABASE_HOST:-127.0.0.1}"
PORT="${DATABASE_PORT:-15432}"
USER_NAME="${DATABASE_USER:-nexus}"
PASSWORD="${DATABASE_PASSWORD:?DATABASE_PASSWORD is required}"
SOURCE_DB="${SOURCE_DB:-nexus_blank_source}"
TARGET_DB="${TARGET_DB:-nexus_blank_target}"
PASSPHRASE="${BACKUP_PASSPHRASE:-scenario-passphrase}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
SOURCE="$WORK/source-installation"
BLANK="$WORK/blank-machine"

ADMIN_URL="postgresql://$USER_NAME:$PASSWORD@$HOST:$PORT/postgres"
SOURCE_URL="postgresql://$USER_NAME:$PASSWORD@$HOST:$PORT/$SOURCE_DB"
TARGET_URL="postgresql://$USER_NAME:$PASSWORD@$HOST:$PORT/$TARGET_DB"

steps=0
failures=0

step() {
  steps=$((steps + 1))
  printf '  %-56s %s\n' "$1" "$2"
}

fail() {
  failures=$((failures + 1))
  steps=$((steps + 1))
  printf '  ✗ %-54s %s\n' "$1" "$2"
}

expect_at_least() {
  if [ "$2" -ge "$3" ]; then
    step "✓ $1" "$2"
  else
    fail "$1" "expected >= $3, got $2"
  fi
}

cleanup() {
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SOURCE_DB\"" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$TARGET_DB\"" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

printf '\nNEXUS — reinstallation on a blank machine\n\n'

# ─────────────────────────────────────────────────────────────────────────────
printf 'A. Source installation\n'

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SOURCE_DB\"" >/dev/null
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$SOURCE_DB\"" >/dev/null
step "✓ source database created" "$SOURCE_DB"

mkdir -p "$SOURCE/services/mission-engine/var" \
  "$SOURCE/services/mission-engine/config" \
  "$SOURCE/services/agent/config" \
  "$SOURCE/services/api/config"
cp "$REPO/pnpm-workspace.yaml" "$SOURCE/pnpm-workspace.yaml"
printf '{ "name": "nexus-source-scenario", "version": "1.0.0", "private": true }\n' \
  > "$SOURCE/package.json"
{
  printf 'NODE_ENV=development\n'
  printf 'DATABASE_URL=%s?schema=public\n' "$SOURCE_URL"
  printf 'REDIS_URL=redis://127.0.0.1:6379\n'
} > "$SOURCE/.env"
chmod 600 "$SOURCE/.env"
step "✓ synthetic source installation" "isolated from current repo"

( cd "$REPO" && DATABASE_URL="$SOURCE_URL?schema=public" \
  pnpm --filter @nexus/database exec prisma migrate deploy >/dev/null )
step "✓ migrations applied" "source"

# Seed data via direct SQL
psql "$SOURCE_URL" -q -f "$REPO/scripts/blank-machine-seed.sql" >/dev/null
step "✓ account, conversation, and messages seeded" "2 messages"

( cd "$REPO" \
  && uv run --project services/mission-engine python scripts/blank-machine-seed.py \
    "$SOURCE/services/mission-engine/var/nexus-engine-production.db" >/dev/null )
step "✓ mission seeded in engine" "1 mission"

# Agent profiles and engine runtime settings
printf '{"codex":{"command":"codex","args":["--json"],"marker":"scenario"}}\n' \
  > "$SOURCE/services/agent/config/profiles.production.json"
printf '{"task_timeout_seconds":1800,"marker":"scenario"}\n' \
  > "$SOURCE/services/mission-engine/config/runtime-settings.json"
step "✓ profiles and settings seeded" "scenario marker"

mkdir -p "$WORK/archives"
( cd "$REPO" && HOME="$WORK/home-source" node packages/cli/dist/index.js backup \
  --root "$SOURCE" --passphrase "$PASSPHRASE" --keep 50 >/dev/null )
cp "$(ls -t "$SOURCE"/backups/*.nxbk | head -1)" "$WORK/archives/scenario.nxbk"
step "✓ backup created" "$(du -h "$WORK/archives/scenario.nxbk" | cut -f1)"

# ─────────────────────────────────────────────────────────────────────────────
printf '\nB. Blank machine\n'

mkdir -p "$BLANK"
git -C "$REPO" archive --format=tar HEAD | tar -x -C "$BLANK"
step "✓ clean extraction of tracked files" "git archive HEAD"

for absent in .env backups services/mission-engine/var packages/cli/dist node_modules .git; do
  if [ -e "$BLANK/$absent" ]; then
    fail "clean extraction check" "$absent is present"
  fi
done
step "✓ no .env, dist, data, dependencies, or .git" "clean clone"

( cd "$BLANK" && pnpm install --frozen-lockfile --silent >/dev/null 2>&1 )
step "✓ dependencies installed" "pnpm install --frozen-lockfile"

( cd "$BLANK" && pnpm build --concurrency 2 >/dev/null 2>&1 )
step "✓ build" "pnpm build"

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$TARGET_DB\"" >/dev/null
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$TARGET_DB\"" >/dev/null

# `nexus setup` creates .env, generates keys, writes systemd unit
( cd "$BLANK" && HOME="$WORK/home-blank" node packages/cli/dist/index.js setup >/dev/null )
if [ -f "$BLANK/.env" ]; then
  step "✓ nexus setup created .env" "mode $(stat -c '%a' "$BLANK/.env")"
else
  fail "nexus setup" ".env missing"
fi
if grep -q "BEGIN PRIVATE KEY" "$BLANK/.env"; then
  step "✓ persistent signing key generated" "Ed25519"
else
  fail "signing key" "missing from generated .env"
fi

( cd "$BLANK" && node -e '
const fs = require("node:fs");
const url = process.argv[1];
const before = fs.readFileSync(".env", "utf8");
const after = /^DATABASE_URL=/m.test(before)
  ? before.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url}`)
  : `${before}\nDATABASE_URL=${url}\n`;
fs.writeFileSync(".env", after);
' "$TARGET_URL?schema=public" )

( cd "$BLANK" && DATABASE_URL="$TARGET_URL?schema=public" \
  pnpm --filter @nexus/database exec prisma migrate deploy >/dev/null )
step "✓ migrations applied" "blank machine"

( cd "$BLANK" && HOME="$WORK/home-blank" node packages/cli/dist/index.js restore \
  "$WORK/archives/scenario.nxbk" --passphrase "$PASSPHRASE" --yes >/dev/null )
step "✓ restore" "nexus restore"

# ─────────────────────────────────────────────────────────────────────────────
printf '\nC. Post-restore verification\n'

count() { psql "$TARGET_URL" -t -A -c "$1" | tr -d '[:space:]'; }

expect_at_least "accounts" "$(count 'SELECT count(*) FROM users')" 1
expect_at_least "conversations" "$(count 'SELECT count(*) FROM conversations')" 1
expect_at_least "messages" "$(count 'SELECT count(*) FROM messages')" 2

TITLE="$(psql "$TARGET_URL" -t -A -c \
  "SELECT title FROM conversations WHERE id='22222222-2222-7222-8222-222222222222'")"
if [ "$TITLE" = "Conversation to recover" ]; then
  step "✓ conversation title" "$TITLE"
else
  fail "conversation title" "got '$TITLE'"
fi

ENGINE="$BLANK/services/mission-engine/var/nexus-engine-production.db"
if [ -f "$ENGINE" ]; then
  expect_at_least "missions in engine" "$(sqlite3 "$ENGINE" 'SELECT count(*) FROM missions')" 1
  MISSION="$(sqlite3 "$ENGINE" \
    "SELECT title FROM missions WHERE external_key='scenario-blank-machine'")"
  if [ "$MISSION" = "Mission to recover" ]; then
    step "✓ mission recovered by external key" "$MISSION"
  else
    fail "recovered mission" "got '$MISSION'"
  fi
else
  fail "engine database" "missing after restore"
fi

if grep -q '"marker":"scenario"' \
  "$BLANK/services/agent/config/profiles.production.json" 2>/dev/null; then
  step "✓ agent profiles restored" "scenario marker found"
else
  fail "agent profiles" "not restored"
fi

if grep -q '"marker":"scenario"' \
  "$BLANK/services/mission-engine/config/runtime-settings.json" 2>/dev/null; then
  step "✓ engine settings restored" "scenario marker found"
else
  fail "engine settings" "not restored"
fi

TOLERATED='Redis|Mission Engine|\(paths\)|\(chemins\)'
DOCTOR_OUT="$WORK/doctor.txt"
( cd "$BLANK" && HOME="$WORK/home-blank" node packages/cli/dist/index.js doctor \
    > "$DOCTOR_OUT" 2>&1 ) || true

grep '✗' "$DOCTOR_OUT" | sed 's/^/      /' || true
OBSERVED="$(grep -c '✗' "$DOCTOR_OUT" || true)"
UNEXPECTED="$(grep '✗' "$DOCTOR_OUT" | grep -Evc "$TOLERATED" || true)"

if [ "$UNEXPECTED" -gt 0 ]; then
  fail "nexus doctor" "$UNEXPECTED failure(s) outside tolerated list"
elif [ "$OBSERVED" -eq 0 ]; then
  step "✓ nexus doctor" "no failed checks"
else
  step "✓ nexus doctor" "$OBSERVED failure(s), all within tolerated list"
fi

printf '\n%d steps, %d failure(s)\n\n' "$steps" "$failures"
[ "$failures" -eq 0 ]
