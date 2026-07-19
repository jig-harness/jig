#!/usr/bin/env bash
# Gate: every relative markdown link resolves to an existing file.
#
# Scope notes (why the exclusions): `templates/` files are skeletons whose
# links are meant to resolve in a CONSUMER repo, not here; `fixtures/` hold
# deliberately broken inputs for self-tests; `seeds/` and `docs/` vendor
# external material verbatim (frozen, not maintained here).
#
# Usage: check-md-links.sh [root-dir]
set -euo pipefail
ROOT="${1:-.}"
fail=0

while IFS= read -r file; do
  dir=$(dirname "$file")
  # Pull out inline-link targets: the "(target)" part of "[text](target)".
  while IFS= read -r target; do
    [ -z "$target" ] && continue
    case "$target" in
      http://*|https://*|mailto:*|'#'*|'<'*) continue ;;
    esac
    path="${target%%#*}"          # drop any #anchor
    path="${path% }"
    [ -z "$path" ] && continue
    if [ ! -e "$dir/$path" ]; then
      echo "broken link: $file -> $target"
      fail=1
    fi
  done < <(grep -o '](\([^)]*\))' "$file" 2>/dev/null | sed 's/^](//; s/)$//')
done < <(find "$ROOT" -name '*.md' \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/templates/*' \
  -not -path '*/fixtures/*' \
  -not -path '*/seeds/*' \
  -not -path '*/docs/*')

exit "$fail"
