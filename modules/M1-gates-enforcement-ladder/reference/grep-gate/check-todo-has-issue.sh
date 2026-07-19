#!/usr/bin/env bash
# Grep gate: every TODO comment must reference an issue.
#
# Rule (a neutral example — swap in your own): a bare "TODO" rots. Nobody
# owns it and nothing links it to the tracker. Allowed forms carry an issue
# reference:
#   TODO(#123): ...        tracker-native issue number
#   TODO(PROJ-123): ...    project-key style
#
# Suppression: append `todo-exempt: <reason>` on the same line for a
# deliberate exception. The reason is mandatory — a bare `todo-exempt:` does
# not suppress. Register the token in your suppression registry (see
# ../../templates/suppression-registry.md).
#
# Conventions this script demonstrates (see ./README.md):
#   - exit 0 on pass; exit 1 with a formatted violation report on failure
#   - the scan root comes from an env var, so the paired self-test can point
#     the gate at fixture directories
#   - a missing or empty scan root passes: the gate is safe to wire up
#     before the tree it guards exists
#
# Usage:
#   check-todo-has-issue.sh
#   SRC_DIR=path/to/tree check-todo-has-issue.sh
set -u

SRC_DIR="${SRC_DIR:-src}"
SRC_DIR="${SRC_DIR%/}"

if [ ! -d "$SRC_DIR" ]; then
  echo "OK — $SRC_DIR does not exist (nothing to check)"
  exit 0
fi

# Stage 1: every text line containing TODO.
# Stage 2: drop lines whose TODO carries an issue reference.
# Stage 3: drop lines carrying a justified suppression token (reason required:
#          the pattern demands a non-space character after the colon).
VIOLATIONS=$(grep -rnI --exclude-dir=.git 'TODO' "$SRC_DIR" 2>/dev/null \
  | grep -vE 'TODO\((#[0-9]+|[A-Za-z][A-Za-z0-9]*-[0-9]+)\)' \
  | grep -vE 'todo-exempt:[[:space:]]*[^[:space:]]' \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: TODO without an issue reference found under $SRC_DIR"
  echo ""
  echo "Every TODO must name an issue: TODO(#123) or TODO(PROJ-123)."
  echo "Deliberate exceptions: add 'todo-exempt: <reason>' on the same line"
  echo "and register the site per the suppression-token registry."
  echo ""
  echo "Offending lines:"
  echo "$VIOLATIONS" | sed 's/^/  /'
  exit 1
fi

echo "OK — every TODO under $SRC_DIR references an issue"
