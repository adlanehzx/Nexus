#!/usr/bin/env bash
#
# Critère de réussite de la priorité 0 : réinstaller NEXUS sur une machine vide
# et retrouver ses missions, ses conversations et ses agents.
#
# Deux temps, dont le second est le seul qui compte :
#
#   A. une installation *source* est peuplée — un compte, une conversation avec
#      ses messages, des profils d'agents, une mission dans la base du moteur —
#      puis sauvegardée. Elle est **synthétique** : un répertoire qui contient
#      exactement ce que la sauvegarde lit. Jamais le dépôt courant : écrire
#      dans la base vivante du moteur pour fabriquer un jeu d'essai serait
#      inacceptable, et c'est à cela que sert `--root` ;
#
#   B. une installation *vierge* est créée par `git clone` : aucun `.env`,
#      aucun `dist`, aucun `var`, aucune sauvegarde. On y déroule l'installation
#      complète — dépendances, construction, `nexus setup`, migrations — on
#      restaure, et on vérifie ce qu'on devait retrouver.
#
# Le clone est ce qui donne sa valeur au test. Réutiliser le répertoire courant
# en effaçant quelques fichiers laisserait traîner tout ce qu'on a oublié, et
# c'est précisément ce qu'on veut prouver absent.
#
#   DATABASE_PASSWORD=... scripts/blank-machine-restore.sh

set -euo pipefail

HOST="${DATABASE_HOST:-127.0.0.1}"
PORT="${DATABASE_PORT:-15432}"
USER_NAME="${DATABASE_USER:-nexus}"
PASSWORD="${DATABASE_PASSWORD:?DATABASE_PASSWORD est requis}"
SOURCE_DB="${SOURCE_DB:-nexus_blank_source}"
TARGET_DB="${TARGET_DB:-nexus_blank_target}"
PASSPHRASE="${BACKUP_PASSPHRASE:-phrase-du-scenario}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
SOURCE="$WORK/installation-source"
BLANK="$WORK/machine-vide"

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
    fail "$1" "attendu ≥ $3, obtenu $2"
  fi
}

cleanup() {
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SOURCE_DB\"" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$TARGET_DB\"" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

printf '\nNEXUS — réinstallation sur une machine vide\n\n'

# ─────────────────────────────────────────────────────────────────────────────
printf 'A. Installation source\n'

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SOURCE_DB\"" >/dev/null
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$SOURCE_DB\"" >/dev/null
step "✓ base source créée" "$SOURCE_DB"

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
step "✓ installation source synthétique" "sans toucher au dépôt courant"

( cd "$REPO" && DATABASE_URL="$SOURCE_URL?schema=public" \
  pnpm --filter @nexus/database exec prisma migrate deploy >/dev/null )
step "✓ migrations appliquées" "source"

# Données applicatives en SQL direct : le scénario éprouve la sauvegarde et la
# restauration, pas l'API — un semis qui passerait par elle échouerait pour des
# raisons sans rapport.
psql "$SOURCE_URL" -q -f "$REPO/scripts/blank-machine-seed.sql" >/dev/null
step "✓ compte, conversation et messages semés" "2 messages"

# La mission passe par le dépôt du moteur : c'est lui qui connaît son schéma,
# et un INSERT à la main deviendrait faux à la première migration.
( cd "$REPO/services/mission-engine" \
  && .venv/bin/python "$REPO/scripts/blank-machine-seed.py" \
    "$SOURCE/services/mission-engine/var/nexus-engine-production.db" >/dev/null )
step "✓ mission semée dans le moteur" "1 mission"

# Les profils d'agents : la pièce qu'on oublie, et sans laquelle une base
# restaurée ne sait plus router une tâche.
printf '{"codex":{"command":"codex","args":["--json"],"marqueur":"scenario"}}\n' \
  > "$SOURCE/services/agent/config/profiles.production.json"
printf '{"task_timeout_seconds":1800,"marqueur":"scenario"}\n' \
  > "$SOURCE/services/mission-engine/config/runtime-settings.json"
step "✓ profils et réglages semés" "marqueur scenario"

mkdir -p "$WORK/archives"
( cd "$REPO" && HOME="$WORK/home-source" node packages/cli/dist/index.js backup \
  --root "$SOURCE" --passphrase "$PASSPHRASE" --keep 50 >/dev/null )
cp "$(ls -t "$SOURCE"/backups/*.nxbk | head -1)" "$WORK/archives/scenario.nxbk"
step "✓ sauvegarde créée" "$(du -h "$WORK/archives/scenario.nxbk" | cut -f1)"

# ─────────────────────────────────────────────────────────────────────────────
printf '\nB. Machine vide\n'

# `git archive` plutôt que `git clone` : il extrait exactement les fichiers
# **suivis** à HEAD, ce qui est la meilleure définition d'une machine vide — et
# il fonctionne sur un dépôt en HEAD détaché, ce qui est le cas d'un checkout de
# CI, là où `clone` peut refuser faute de branche. L'absence de `.git` est un
# bonus : une copie déployée sans historique doit rester une installation
# valide, et le scénario le vérifie du même coup.
mkdir -p "$BLANK"
git -C "$REPO" archive --format=tar HEAD | tar -x -C "$BLANK"
step "✓ copie neuve des fichiers suivis" "git archive HEAD"

for absent in .env backups services/mission-engine/var packages/cli/dist node_modules .git; do
  if [ -e "$BLANK/$absent" ]; then
    fail "le clone devrait être vierge" "$absent est présent"
  fi
done
step "✓ ni .env, ni dist, ni données, ni dépendances, ni .git" "copie vierge"

( cd "$BLANK" && pnpm install --frozen-lockfile --silent >/dev/null 2>&1 )
step "✓ dépendances installées" "pnpm install --frozen-lockfile"

( cd "$BLANK" && pnpm build --concurrency 2 >/dev/null 2>&1 )
step "✓ construction" "pnpm build"

psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$TARGET_DB\"" >/dev/null
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$TARGET_DB\"" >/dev/null

# `nexus setup` sur une installation nue : c'est lui qui crée le `.env`, génère
# la clé persistante, dépose la clé publique et écrit l'unité systemd.
( cd "$BLANK" && HOME="$WORK/home-blank" node packages/cli/dist/index.js setup >/dev/null )
if [ -f "$BLANK/.env" ]; then
  step "✓ nexus setup a créé .env" "mode $(stat -c '%a' "$BLANK/.env")"
else
  fail "nexus setup" ".env absent"
fi
if grep -q "BEGIN PRIVATE KEY" "$BLANK/.env"; then
  step "✓ clé de signature persistante générée" "Ed25519"
else
  fail "clé de signature" "absente du .env généré"
fi

# La base cible est l'unique valeur que le scénario impose à l'installation :
# `setup` en a généré une locale, qui ne peut pas exister ici.
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
step "✓ migrations appliquées" "machine vide"

( cd "$BLANK" && HOME="$WORK/home-blank" node packages/cli/dist/index.js restore \
  "$WORK/archives/scenario.nxbk" --passphrase "$PASSPHRASE" --yes >/dev/null )
step "✓ restauration" "nexus restore"

# ─────────────────────────────────────────────────────────────────────────────
printf '\nC. Ce qu'"'"'on devait retrouver\n'

count() { psql "$TARGET_URL" -t -A -c "$1" | tr -d '[:space:]'; }

expect_at_least "comptes" "$(count 'SELECT count(*) FROM users')" 1
expect_at_least "conversations" "$(count 'SELECT count(*) FROM conversations')" 1
expect_at_least "messages" "$(count 'SELECT count(*) FROM messages')" 2

TITLE="$(psql "$TARGET_URL" -t -A -c \
  "SELECT title FROM conversations WHERE id='22222222-2222-7222-8222-222222222222'")"
if [ "$TITLE" = "Conversation à retrouver" ]; then
  step "✓ titre de la conversation" "$TITLE"
else
  fail "titre de la conversation" "obtenu « $TITLE »"
fi

ENGINE="$BLANK/services/mission-engine/var/nexus-engine-production.db"
if [ -f "$ENGINE" ]; then
  expect_at_least "missions dans le moteur" "$(sqlite3 "$ENGINE" 'SELECT count(*) FROM missions')" 1
  MISSION="$(sqlite3 "$ENGINE" \
    "SELECT title FROM missions WHERE external_key='scenario-machine-vide'")"
  if [ "$MISSION" = "Mission a retrouver" ]; then
    step "✓ mission retrouvée par sa clé externe" "$MISSION"
  else
    fail "mission retrouvée" "obtenu « $MISSION »"
  fi
else
  fail "base du moteur" "absente après restauration"
fi

if grep -q '"marqueur":"scenario"' \
  "$BLANK/services/agent/config/profiles.production.json" 2>/dev/null; then
  step "✓ profils d'agents restaurés" "marqueur retrouvé"
else
  fail "profils d'agents" "non restaurés"
fi

if grep -q '"marqueur":"scenario"' \
  "$BLANK/services/mission-engine/config/runtime-settings.json" 2>/dev/null; then
  step "✓ réglages du moteur restaurés" "marqueur retrouvé"
else
  fail "réglages du moteur" "non restaurés"
fi

# Le diagnostic doit tourner sur l'installation restaurée. Il peut signaler des
# échecs — et on les nomme plutôt que de les supposer : affirmer « services non
# démarrés » sans l'avoir lu serait exactement le genre de certitude que ce
# scénario existe pour remplacer par une mesure.
DOCTOR_OUT="$WORK/doctor.txt"
if ( cd "$BLANK" && HOME="$WORK/home-blank" node packages/cli/dist/index.js doctor \
      > "$DOCTOR_OUT" 2>&1 ); then
  step "✓ nexus doctor" "aucune vérification en échec"
else
  # Un seul échec est attendu, et pour une raison qui tient au scénario : les
  # unités systemd sont globales à la session utilisateur, pas propres à une
  # installation. Vu du clone, l'unité installée sur la machine désigne une
  # autre racine — et `doctor` a raison de le dire. Tout autre échec, en
  # revanche, est un vrai défaut de la restauration.
  UNEXPECTED="$(grep '✗' "$DOCTOR_OUT" | grep -vc '(chemins)' || true)"
  grep '✗' "$DOCTOR_OUT" | sed 's/^/      /'
  if [ "$UNEXPECTED" -eq 0 ]; then
    step "✓ nexus doctor" "seul l'écart de chemins systemd, attendu hors d'une vraie installation"
  else
    fail "nexus doctor" "$UNEXPECTED échec(s) sans rapport avec le scénario"
  fi
fi

printf '\n%d étapes, %d échec(s)\n\n' "$steps" "$failures"
[ "$failures" -eq 0 ]
