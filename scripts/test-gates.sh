#!/usr/bin/env bash
# Self-tests for the repo gates — M1 dogfooded: a gate without a self-test
# can silently stop catching anything. Each case runs a gate against a small
# fixture tree and asserts the expected pass/fail. Cases cd into the fixture
# so the gates' own `*/fixtures/*` path exclusion doesn't skip the inputs.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fx="$here/tests/fixtures"
bad=0

run_case() {  # run_case <pass|fail> <fixture-dir> <cmd...>
  local want=$1 dir=$2; shift 2
  local got=0
  (cd "$fx/$dir" && "$@" >/dev/null 2>&1) || got=$?
  if { [ "$want" = pass ] && [ "$got" -eq 0 ]; } ||
     { [ "$want" = fail ] && [ "$got" -ne 0 ]; }; then
    echo "ok: $dir ($(basename "$1"))"
  else
    echo "FAIL: $dir expected $want, got exit=$got"
    bad=1
  fi
}

run_case pass pass          "$here/check-md-links.sh" .
run_case pass pass          "$here/check-md-tables.sh" .
run_case pass pass          "$here/check-glossary-coverage.sh" . GLOSSARY.md allowlist.txt
run_case fail fail-link     "$here/check-md-links.sh" .
run_case fail fail-table    "$here/check-md-tables.sh" .
run_case fail fail-glossary "$here/check-glossary-coverage.sh" . GLOSSARY.md allowlist.txt

exit "$bad"
