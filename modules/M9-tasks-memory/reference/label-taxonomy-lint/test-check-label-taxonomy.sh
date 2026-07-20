#!/usr/bin/env bash
# Self-test for check-label-taxonomy.sh. Asserts a valid taxonomy passes and
# each broken invariant (duplicate id, flag with no `fires:`, empty status list,
# unknown top-level key) fails. CI runs it so the taxonomy gate can't silently
# break.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-label-taxonomy.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <taxonomy-file>
  TAXONOMY="$3" "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run 0 "valid taxonomy passes"          "$fix/good/label-taxonomy.yaml"
run 1 "duplicate label id fails"       "$fix/bad/duplicate-id.yaml"
run 1 "flag missing fires fails"       "$fix/bad/flag-missing-fires.yaml"
run 1 "flag with empty-list fires fails" "$fix/bad/flag-empty-list-fires.yaml"
run 1 "flag with duplicate fires fails"  "$fix/bad/flag-duplicate-fires.yaml"
run 1 "empty statuses list fails"      "$fix/bad/empty-statuses.yaml"
run 1 "unknown top-level key fails"    "$fix/bad/unknown-key.yaml"
run 1 "duplicate top-level key fails"  "$fix/bad/duplicate-types-key.yaml"
run 2 "missing taxonomy file errors"   "$fix/bad/does-not-exist.yaml"

[ "$rc" -eq 0 ] && echo "All label-taxonomy-lint self-tests passed." || echo "label-taxonomy-lint self-tests FAILED."
exit "$rc"
