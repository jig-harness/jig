#!/usr/bin/env bash
# Regresses a false-agreement bug: web-app is declared as an area twice in
# the paired catalog, each with its own paths: field. A per-area
# duplicate-paths: tracker that resets on every area-name line, without
# also tracking which identifiers it has already seen, treats the second
# web-app: as a brand new area — never flagging the repeated key — and
# unions both entries' globs. A real YAML parser sees one duplicate
# mapping key and keeps only one value (commonly the last, rogue/**), so
# ^apps/ should not be certified as covered. Must be a hard error.
CODE_PATH_RE='^apps/'
