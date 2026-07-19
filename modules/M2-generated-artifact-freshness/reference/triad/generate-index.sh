#!/bin/sh
# generate-index.sh — the GENERATOR third of the freshness triad.
#
# Derives an index.md from a directory tree of markdown files: one bullet per
# file, titled by the file's first `# ` heading (falling back to its path).
# The output is deterministic — same input tree, byte-identical output — which
# is what makes the sibling drift check (check-index-fresh.sh) possible.
#
# This is a deliberately tiny worked example of the pattern; the same shape
# applies to any generated artifact (API specs, ORM types, dependency
# notices). Portable POSIX shell: no bash-isms, no runtime dependencies.
#
# Usage:
#   sh generate-index.sh <docs-dir> [output-file]
#
# Default output is <docs-dir>/index.md. Files named index.md are always
# excluded from the listing, so the artifact never indexes itself.
set -eu

DOCS_DIR="${1:?usage: generate-index.sh <docs-dir> [output-file]}"
OUT="${2:-$DOCS_DIR/index.md}"

[ -d "$DOCS_DIR" ] || { echo "error: not a directory: $DOCS_DIR" >&2; exit 2; }

# Strip a single trailing slash so relative paths in the listing are clean.
DOCS_DIR="${DOCS_DIR%/}"

# Build in a temp file and move into place, so a crash mid-write can never
# leave a half-written artifact behind.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT INT TERM

{
  # The header marks the file as generated and says how to regenerate it.
  # Keep it STATIC (no embedded arguments, dates, or hostnames): anything
  # run-dependent in the output breaks determinism and turns the drift
  # check into a coin flip.
  echo '<!-- GENERATED FILE - do not edit by hand.'
  echo '     Regenerate: sh generate-index.sh <docs-dir>  (see README.md) -->'
  echo '# Index'
  echo ''
  # LC_ALL=C pins the sort order: locale-dependent collation is a classic
  # source of "drift" that is really just two machines sorting differently.
  find "$DOCS_DIR" -name '*.md' ! -name 'index.md' | LC_ALL=C sort |
    while IFS= read -r file; do
      rel="${file#"$DOCS_DIR"/}"
      title=$(sed -n 's/^# //p' "$file" | head -n 1)
      [ -n "$title" ] || title="$rel"
      printf -- '- [%s](%s)\n' "$title" "$rel"
    done
} > "$TMP"

mv "$TMP" "$OUT"
trap - EXIT INT TERM
echo "generated: $OUT" >&2
