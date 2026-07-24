#!/usr/bin/env bash
# Gate: every markdown table is preceded by a blank line (many renderers,
# including GitHub's under some conditions, refuse to render a table glued to
# the paragraph above it). Fenced code blocks are ignored; `seeds/` is
# vendored verbatim and `fixtures/` are deliberately broken self-test inputs,
# so both are out of scope. Only tracked and non-ignored untracked Markdown is
# checked; ignored workspaces/caches are not repository content.
#
# Usage: check-md-tables.sh [root-dir]
set -euo pipefail
ROOT="${1:-.}"

markdown_files() {
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" ls-files --cached --others --exclude-standard -- '*.md' |
      while IFS= read -r relative; do
        case "$relative" in
          fixtures/*|*/fixtures/*|seeds/*|*/seeds/*) continue ;;
        esac
        printf '%s/%s\n' "${ROOT%/}" "$relative"
      done
  else
    find "$ROOT" -name '*.md' \
      -not -path '*/.git/*' \
      -not -path '*/node_modules/*' \
      -not -path '*/fixtures/*' \
      -not -path '*/seeds/*'
  fi
}

bad=0
while IFS= read -r file; do
  awk '
  FNR == 1 { prev = ""; infence = 0 }
  /^[[:space:]]*(```|~~~)/ { infence = !infence; prev = $0; next }
  infence { prev = $0; next }
  /^[[:space:]]*\|/ {
    if (prev !~ /^[[:space:]]*\|/ && prev !~ /^[[:space:]]*$/) {
      printf "%s:%d: table not preceded by a blank line\n", FILENAME, FNR
      bad = 1
    }
  }
  { prev = $0 }
  END { exit bad }
' "$file" || bad=1
done < <(markdown_files)

exit "$bad"
