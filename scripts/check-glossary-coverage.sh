#!/usr/bin/env bash
# Gate: terms of art are defined. Acronyms are the mechanical proxy: any
# acronym-shaped token (starts and ends uppercase, e.g. HITL, SSoT, ADR) used
# in the repo's own prose must appear somewhere in GLOSSARY.md or in the
# allowlist (scripts/glossary-allowlist.txt — file names, format names, and
# other non-terms). Fenced code blocks are ignored; `templates/`, `fixtures/`,
# `seeds/`, and vendored `docs/` are out of scope for the same reasons as the
# link check. Only tracked and non-ignored untracked Markdown is checked;
# ignored workspaces/caches are not repository content.
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

markdown_files() {
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" ls-files --cached --others --exclude-standard -- '*.md' |
      while IFS= read -r relative; do
        case "$relative" in
          templates/*|*/templates/*|fixtures/*|*/fixtures/*|seeds/*|*/seeds/*|docs/*|*/docs/*) continue ;;
        esac
        printf '%s/%s\n' "${ROOT%/}" "$relative"
      done
  else
    find "$ROOT" -name '*.md' \
      -not -path '*/.git/*' \
      -not -path '*/node_modules/*' \
      -not -path '*/templates/*' \
      -not -path '*/fixtures/*' \
      -not -path '*/seeds/*' \
      -not -path '*/docs/*'
  fi
}

fail=0
while IFS= read -r file; do
  [ "$file" -ef "$GLOSSARY" ] && continue
  missing=$(comm -23 <(acronyms "$file") <(printf '%s\n' "$known")) || true
  if [ -n "$missing" ]; then
    for term in $missing; do
      echo "undefined term of art: '$term' in $file (define it in GLOSSARY.md or allowlist it)"
    done
    fail=1
  fi
done < <(markdown_files)

exit "$fail"
