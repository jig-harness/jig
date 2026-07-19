#!/bin/sh
# check-index-fresh.sh — the DRIFT-CHECK third of the freshness triad.
#
# Regenerates the index into a temp file and diffs it against the committed
# copy. Exit 0 when identical; exit 1 (with the diff and a "run this to fix"
# message) when the committed artifact is stale. Run it in CI on every pull
# request so a stale artifact can never merge.
#
# The check reuses the real generator rather than reimplementing its logic —
# a drift check with its own private idea of "fresh" just creates a third
# copy that can drift.
#
# Usage:
#   sh check-index-fresh.sh <docs-dir> [index-file]
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
DOCS_DIR="${1:?usage: check-index-fresh.sh <docs-dir> [index-file]}"
DOCS_DIR="${DOCS_DIR%/}"
INDEX="${2:-$DOCS_DIR/index.md}"

FIX_CMD="sh generate-index.sh $DOCS_DIR"

if [ ! -f "$INDEX" ]; then
  echo "STALE: $INDEX does not exist." >&2
  echo "To fix: $FIX_CMD && git add $INDEX" >&2
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT INT TERM

sh "$SCRIPT_DIR/generate-index.sh" "$DOCS_DIR" "$TMP" 2>/dev/null

if diff -u "$INDEX" "$TMP"; then
  echo "OK: $INDEX matches what the generator produces."
else
  echo '' >&2
  echo "STALE: $INDEX no longer matches its source of truth ($DOCS_DIR)." >&2
  echo "A committed generated artifact must never be hand-edited or left" >&2
  echo "behind when its inputs change." >&2
  echo '' >&2
  echo "To fix: $FIX_CMD && git add $INDEX" >&2
  exit 1
fi
