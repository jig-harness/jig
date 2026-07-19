#!/usr/bin/env bash
# Self-test for check-catalog-regex-sync.sh. Runs the gate against fixtures and
# asserts pass on a synced pair, fail on a regex prefix missing from the
# catalog. A gate whose regex silently stops matching is worse than no gate, so
# the gate ships with this test and CI runs it (see ../../../M1 grep-gate).
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-catalog-regex-sync.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <filter> <catalog>
  local want=$1 label=$2 filter=$3 catalog=$4 got
  FILTER_FILE="$filter" CATALOG="$catalog" RE_VAR=CODE_PATH_RE \
    "$gate" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then
    echo "PASS: $label (exit $got)"
  else
    echo "FAIL: $label (want exit $want, got $got)"
    rc=1
  fi
}

run 0 "synced regex/catalog passes"        "$fix/synced/filter.sh"  "$fix/synced/catalog.yaml"
run 1 "regex prefix absent from catalog"   "$fix/drift/filter.sh"   "$fix/drift/catalog.yaml"

[ "$rc" -eq 0 ] && echo "All regex-mirror self-tests passed." || echo "Regex-mirror self-tests FAILED."
exit "$rc"
