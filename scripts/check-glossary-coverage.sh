#!/usr/bin/env bash
# Gate: terms of art are defined. Acronyms are the mechanical proxy: any
# acronym-shaped token (starts and ends uppercase, e.g. HITL, SSoT, ADR) used
# in the repo's own prose must appear somewhere in GLOSSARY.md or in the
# allowlist (scripts/glossary-allowlist.txt — file names, format names, and
# other non-terms). Fenced code blocks are ignored; `templates/`, `fixtures/`,
# `seeds/`, and vendored `docs/` are out of scope for the same reasons as the
# link check.
#
# Usage: check-glossary-coverage.sh [root-dir] [glossary-file] [allowlist-file]
set -euo pipefail
ROOT="${1:-.}"
GLOSSARY="${2:-$ROOT/GLOSSARY.md}"
ALLOWLIST="${3:-$ROOT/scripts/glossary-allowlist.txt}"

acronyms() {  # strip fenced code blocks + inline code, then extract tokens
  awk '
    /^[[:space:]]*(```|~~~)/ { infence = !infence; next }
    !infence { gsub(/`[^`]*`/, ""); print }
  ' "$@" | grep -oE '\b[A-Z][A-Za-z]*[A-Z]\b' | sort -u
}

defined=$(acronyms "$GLOSSARY")
allowed=$(grep -v '^#' "$ALLOWLIST" 2>/dev/null | grep -v '^[[:space:]]*$' || true)
known=$(printf '%s\n%s\n' "$defined" "$allowed" | sort -u)

fail=0
while IFS= read -r file; do
  missing=$(comm -23 <(acronyms "$file") <(printf '%s\n' "$known")) || true
  if [ -n "$missing" ]; then
    for term in $missing; do
      echo "undefined term of art: '$term' in $file (define it in GLOSSARY.md or allowlist it)"
    done
    fail=1
  fi
done < <(find "$ROOT" -name '*.md' \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/templates/*' \
  -not -path '*/fixtures/*' \
  -not -path '*/seeds/*' \
  -not -path '*/docs/*' \
  ! -samefile "$GLOSSARY")

exit "$fail"
