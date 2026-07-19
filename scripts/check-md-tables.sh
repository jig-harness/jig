#!/usr/bin/env bash
# Gate: every markdown table is preceded by a blank line (many renderers,
# including GitHub's under some conditions, refuse to render a table glued to
# the paragraph above it). Fenced code blocks are ignored; `seeds/` is
# vendored verbatim and `fixtures/` are deliberately broken self-test inputs,
# so both are out of scope.
#
# Usage: check-md-tables.sh [root-dir]
set -euo pipefail
ROOT="${1:-.}"

find "$ROOT" -name '*.md' \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/fixtures/*' \
  -not -path '*/seeds/*' \
  -print0 |
xargs -0 awk '
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
'
