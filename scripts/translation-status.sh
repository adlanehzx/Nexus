#!/usr/bin/env bash
#
# How much French is left, by area.
#
# The project declares itself English (see CONTRIBUTING.md), and part of the
# codebase predates that rule. This script exists so that "being translated" is
# a number anyone can re-run rather than an intention nobody can check — and so
# the figure can only go down.
#
# The heuristic detects accented characters as well as common ASCII French words
# and phrases (e.g. "dans", "avec", "sans", "pour", "cette", "fichier", etc.).
#
# Usage:
#   pnpm translation:status
#   pnpm translation:status --check         # fail while French remains in packages or userMessage
#   pnpm translation:status --check all     # fail while French remains across any area
#   pnpm translation:status --files <area>  # list the remaining files in one area
set -euo pipefail

# ==============================================================================
# Intentional Multilingual Allowlist (Product Requirements)
#
# The following files contain intentional multilingual support required for
# product behavior and are excluded from the English-only scan:
#
# 1. packages/web-search/src/evidence.ts
#    - Bilingual stop-word filter (STOP_WORDS) required for French citation
#      tokenization and query coverage.
# 2. packages/memory/src/commands.ts
#    - Deterministic multilingual command parsing (retiens, souviens-toi,
#      mémorise, oublie, etc.) for bilingual voice/chat memory interaction.
# 3. packages/memory/src/extraction.ts
#    - Multilingual memory extraction heuristics matching personal declarations
#      (je, j', mon, ma, prefere, aime) in user speech.
# 4. packages/memory/src/sensitivity.ts
#    - Sensitive PII and secret detection regexes covering French credentials,
#      identity tokens, health terms, and bank details (mot de passe, clé api,
#      ordonnance, sécurité sociale, etc.).
# 5. packages/memory/src/embedding.ts
#    - Local semantic embedding synonym dictionary (ALIASES) mapping
#      multilingual terms (e.g. adore -> aime).
# 6. packages/memory/test/sensitivity.test.ts
#    - Test fixtures explicitly verifying that French credentials and personal
#      data are classified as sensitive by the policy engine.
# ==============================================================================
ALLOWLIST_REGEX='packages/web-search/src/evidence\.ts|packages/memory/src/commands\.ts|packages/memory/src/extraction\.ts|packages/memory/src/sensitivity\.ts|packages/memory/src/embedding\.ts|packages/memory/test/sensitivity\.test\.ts'

ACCENTS='[àâäéèêëîïôöùûüçœÀÂÉÈÊËÎÏÔÙÛÇŒ]'
FRENCH_ASCII="\b(dans|avec|pour|cette|fichier|fichiers|dossier|dossiers|aucune|aucun|chaque|plusieurs|tous|toutes)\b|\b(connexion|indisponible|introuvable|utilisateur|utilisateurs|jeton|jetons)\b|\b(erreur|erreurs|requete|requetes|reponse|reponses|succes|echec|echecs)\b|\b(n'est|c'est|s'il|d'un|d'une|l'un|l'une|qu'un|qu'une)\b|\b(pas de|ne pas|au moins|en cours|non valide|est valide|n'a pas|ne peut)\b|\b(doit|doivent|peut|peuvent|sont|etait|sera|seront)\b|\b(titre|objet|prenom|adresse|adresses)\b|\b(injoignable|exploitable|redirection|redirections)\b|\b(autorise|autorisee|autoriser|interdit|interdite|bloque|bloquee)\b|\b(brouillon|brouillons|boite|envoi|envoyer|supprimer|modifier)\b|\b(recherche|securite|confidentialite)\b|\b(autre|autres|comme|aussi|meme|selon|sous)\b|\b(chiffrement|sauvegarde|sauvegardes|restauration)\b|\b(parametres|journaux)\b|\b(toujours|jamais|souvent|parfois|maintenant)\b|\b(authentification|requise|identifiants?)\b"
PATTERN="($ACCENTS|$FRENCH_ASCII)"

AREAS=(root .github docs packages services apps evals mcp scripts infrastructure packaging)

sources() {
  local area="$1"
  if [ "$area" = "root" ]; then
    git ls-files | awk 'index($0, "/") == 0'
  else
    git ls-files "$area"
  fi \
    | grep -vE '(^|/)(node_modules|dist|generated|\.turbo|\.venv|__pycache__)/' \
    | grep -vE '(\.bundle$|/gen/)' \
    | grep -v '^scripts/translation-status\.sh$' \
    | grep -vE "$ALLOWLIST_REGEX" \
    | while IFS= read -r file; do
        grep -Iq . "$file" && printf '%s\n' "$file"
      done
}

if [ "${1:-}" = "--files" ]; then
  area="${2:?usage: --files <area>}"
  sources "$area" | xargs grep -i -lE "$PATTERN" 2>/dev/null | sort | while read -r f; do
    printf '%6s  %s\n' "$(grep -i -cE "$PATTERN" "$f")" "$f"
  done | sort -rn
  exit 0
fi

check=false
check_target="packages"
if [ "${1:-}" = "--check" ]; then
  check=true
  if [ -n "${2:-}" ]; then
    check_target="$2"
  fi
fi

printf '%-18s %10s %10s\n' 'area' 'files' 'lines'
printf '%-18s %10s %10s\n' '------------------' '----------' '----------'

total_files=0
total_lines=0
declare -A area_lines

for area in "${AREAS[@]}"; do
  [ "$area" = "root" ] || [ -d "$area" ] || continue
  files=$({ sources "$area" | xargs -r grep -i -lE "$PATTERN" 2>/dev/null || true; } | wc -l | tr -d ' ')
  lines=$({ sources "$area" | xargs -r grep -i -hE "$PATTERN" 2>/dev/null || true; } | wc -l | tr -d ' ')
  area_lines["$area"]="$lines"
  [ "$files" -eq 0 ] && continue
  printf '%-18s %10s %10s\n' "$area" "$files" "$lines"
  total_files=$((total_files + files))
  total_lines=$((total_lines + lines))
done

printf '%-18s %10s %10s\n' '------------------' '----------' '----------'
printf '%-18s %10s %10s\n' 'total' "$total_files" "$total_lines"

# Test names are counted separately: they are the lowest-value item in the
# queue — no outside reader sees them — and the highest-risk to change, since a
# rename can break a test filter in CI.
names=$({ find packages services apps evals -name '*.test.ts' -o -name '*.test.tsx' 2>/dev/null \
  | grep -v node_modules | grep -vE "$ALLOWLIST_REGEX" | xargs grep -hE '(it|describe|test)\("' 2>/dev/null \
  | grep -i -cE "$PATTERN" || true; } | tr -d ' ')
printf '\n%-18s %10s\n' 'test names' "${names:-0}"

printf '\nUser-facing strings: '
remaining=$({ grep -rn 'userMessage' --include='*.ts' packages services apps 2>/dev/null \
  | grep -v node_modules | grep -v '/dist/' | grep -vE ':\s*\*|//' \
  | grep -iE "$PATTERN" || true; } | wc -l | tr -d ' ')
if [ "${remaining:-0}" -eq 0 ]; then
  printf 'no French left in any userMessage.\n'
else
  printf '%s remaining.\n' "$remaining"
fi

if [ "$check" = true ]; then
  failed=false

  if [ "${remaining:-0}" -ne 0 ]; then
    printf '\nFailure: %s French user-facing string(s) remain in userMessage.\n' "$remaining" >&2
    failed=true
  fi

  if [ "$check_target" = "all" ]; then
    if [ "$total_lines" -ne 0 ]; then
      printf '\nFailure: %s untranslated French line(s) remain across codebase.\n' "$total_lines" >&2
      failed=true
    fi
  else
    target_lines="${area_lines["$check_target"]:-0}"
    if [ "$target_lines" -ne 0 ]; then
      printf '\nFailure: %s untranslated French line(s) remain in %s.\n' "$target_lines" "$check_target" >&2
      failed=true
    fi
  fi

  if [ "$failed" = true ]; then
    printf '\nEnglish-only check failed: translate remaining lines before release.\n' >&2
    exit 1
  fi

  printf '\nEnglish-only check passed: %s and userMessage are clean.\n' "$check_target"
fi
