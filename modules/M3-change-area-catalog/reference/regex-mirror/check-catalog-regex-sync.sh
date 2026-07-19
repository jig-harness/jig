#!/usr/bin/env bash
# Regex-mirror guard (regex -> catalog direction).
#
# When a repo keeps a fast hand-written CI regex to answer "did any code
# change?" without running the full change-area resolver, that regex is a
# second copy of part of the catalog and will drift. This gate asserts that
# every path prefix the regex matches is represented in the catalog, so a
# prefix cannot be added to the shortcut without also existing in the source
# of truth. (The reverse direction — every code-bearing catalog path is
# matched by the regex — needs the resolver's closure; see ./README.md.)
#
# How it works:
#   1. Read the alternation regex from the filter file (a shell file assigning
#      CODE_PATH_RE='^apps/|^packages/|...').
#   2. Split it on `|` into segments.
#   3. Normalize each segment to a plain path prefix: strip a leading `^`, a
#      trailing `$`, trailing `.*` / `/**` / `/`, and backslash escapes.
#   4. Assert that prefix appears as a literal substring somewhere in the
#      catalog file. Any segment not found is drift.
#
# Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
#   - exit 0 on pass; exit 1 with a formatted report on failure
#   - inputs come from env vars so the paired self-test can point at fixtures
#   - a missing filter file or catalog is a hard error (unlike a scan-tree
#     gate, there is nothing meaningful to pass when the inputs are absent)
#
# Usage:
#   check-catalog-regex-sync.sh
#   FILTER_FILE=path/to/filter.sh CATALOG=path/to/catalog.yaml check-catalog-regex-sync.sh
set -u

FILTER_FILE="${FILTER_FILE:-tools/ci/detect-changes-filter.sh}"
CATALOG="${CATALOG:-tools/change-areas/catalog.yaml}"
# Name of the variable holding the alternation regex inside FILTER_FILE.
RE_VAR="${RE_VAR:-CODE_PATH_RE}"

fail() { echo "ERROR: $*" >&2; exit 2; }

[ -f "$FILTER_FILE" ] || fail "filter file not found: $FILTER_FILE"
[ -f "$CATALOG" ]     || fail "catalog not found: $CATALOG"

# Pull the regex value: the RHS of `RE_VAR=...`, first match, quotes stripped.
RE=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${RE_VAR}=" "$FILTER_FILE" \
  | head -n1 \
  | sed -E "s/^[^=]*=//; s/^['\"]//; s/['\"][[:space:]]*$//")

[ -n "$RE" ] || fail "could not read \$$RE_VAR from $FILTER_FILE"

MISSING=""
# Split the alternation on `|` and normalize each segment to a path prefix.
# set -f (noglob) so a segment containing glob metacharacters isn't
# pathname-expanded against the working directory during the split.
set -f
OLDIFS=$IFS
IFS='|'
for seg in $RE; do
  IFS=$OLDIFS
  prefix=$(printf '%s' "$seg" \
    | sed -E 's/^\^//; s/\$$//; s/(\.\*|\/\*\*|\/)$//; s/\\//g' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  [ -n "$prefix" ] || { IFS='|'; continue; }
  if ! grep -qF -- "$prefix" "$CATALOG"; then
    MISSING="${MISSING}${prefix}"$'\n'
  fi
  IFS='|'
done
IFS=$OLDIFS
set +f

if [ -n "$MISSING" ]; then
  echo "ERROR: CI code-path regex has prefixes absent from the catalog"
  echo ""
  echo "Every path prefix in \$$RE_VAR ($FILTER_FILE) must appear in the"
  echo "catalog ($CATALOG) — otherwise the fast CI shortcut and the change-area"
  echo "source of truth have drifted apart. Add the prefix to an area's paths,"
  echo "or remove it from the regex."
  echo ""
  echo "Prefixes not found in the catalog:"
  printf '%s' "$MISSING" | sed 's/^/  /'
  exit 1
fi

echo "OK — every prefix in \$$RE_VAR is represented in $CATALOG"
