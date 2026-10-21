#!/usr/bin/env bash
#
# How much French is left, by area.
#
# The project declares itself English (see CONTRIBUTING.md), and part of the
# codebase predates that rule. This script exists so that "being translated" is
# a number anyone can re-run rather than an intention nobody can check — and so
# the figure can only go down.
#
# The heuristic is accented characters, which makes it a **floor**: there is no
# accent in "la raison est que" or "ce qui compte ici". The real volume of prose
# is higher. A floor is enough to track progress, and it never reports success
# it has not earned.
#
# Usage:
#   pnpm translation:status
#   pnpm translation:status --files docs    # list the remaining files in one area
set -euo pipefail

ACCENTS='[àâäéèêëîïôöùûüçœÀÂÉÈÊËÎÏÔÙÛÇŒ]'
AREAS=(docs packages services apps evals mcp scripts infrastructure packaging)

sources() {
  find "$1" -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.js' \
       -o -name '*.py' -o -name '*.md' -o -name '*.rs' -o -name '*.kt' \
       -o -name '*.kts' -o -name '*.yml' -o -name '*.sh' -o -name '*.ps1' \) 2>/dev/null \
    | grep -v node_modules | grep -v '/dist/' | grep -v '/generated/' | grep -v '/.turbo/'
}

if [ "${1:-}" = "--files" ]; then
  area="${2:?usage: --files <area>}"
  sources "$area" | xargs grep -l "$ACCENTS" 2>/dev/null | sort | while read -r f; do
    printf '%6s  %s\n' "$(grep -c "$ACCENTS" "$f")" "$f"
  done | sort -rn
  exit 0
fi

printf '%-18s %10s %10s\n' 'area' 'files' 'lines'
printf '%-18s %10s %10s\n' '------------------' '----------' '----------'

total_files=0
total_lines=0
for area in "${AREAS[@]}"; do
  [ -d "$area" ] || continue
  files=$(sources "$area" | xargs grep -l "$ACCENTS" 2>/dev/null | wc -l | tr -d ' ')
  lines=$(sources "$area" | xargs grep -h "$ACCENTS" 2>/dev/null | wc -l | tr -d ' ')
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
names=$(find packages services apps evals -name '*.test.ts' -o -name '*.test.tsx' 2>/dev/null \
  | grep -v node_modules | xargs grep -hE '(it|describe|test)\("' 2>/dev/null \
  | grep -c "$ACCENTS" || true)
printf '\n%-18s %10s\n' 'test names' "$names"

printf '\nUser-facing strings are done: '
remaining=$(grep -rn 'userMessage' --include='*.ts' packages services apps 2>/dev/null \
  | grep -v node_modules | grep -v '/dist/' | grep "$ACCENTS" | grep -vcE ':\s*\*|//' || true)
if [ "${remaining:-0}" -eq 0 ]; then
  printf 'no French left in any userMessage.\n'
else
  printf '%s remaining.\n' "$remaining"
fi
