#!/usr/bin/env bash
# Self-test for check-formula.sh. Asserts: a closed item with every required
# phase passes; an open (not-yet-done) item passes; a non-done status is not
# gated; a closed item missing a required phase fails; a record with no status
# and an empty formula each error; and the DONE_STATES override actually widens
# what counts as "done". CI runs it so the formula gate can't silently break.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-formula.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <record> [formula]
  local formula="${4:-$fix/formula.yaml}"
  FORMULA="$formula" "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run 0 "closed with all required passes"   "$fix/good/closed-complete.txt"
run 0 "open item not yet gated passes"    "$fix/good/open-incomplete.txt"
run 0 "non-done status is not gated"      "$fix/good/shipped-incomplete.txt"
run 1 "closed missing required fails"     "$fix/bad/closed-missing-required.txt"
run 1 "quoted closed status still gated"  "$fix/bad/closed-quoted-missing.txt"
run 2 "record without status errors"      "$fix/bad/no-status.txt"
run 2 "duplicate status errors"           "$fix/bad/duplicate-status.txt"
run 2 "empty formula errors"              "$fix/good/closed-complete.txt" "$fix/bad/empty-formula.yaml"
run 2 "duplicate required in a phase errors" "$fix/good/closed-complete.txt" "$fix/bad/duplicate-required.yaml"
run 2 "missing record file errors"        "$fix/bad/does-not-exist.txt"

# DONE_STATES override: `shipped` is not done by default (passes above), but
# once it is declared a done state the same incomplete record must fail.
DONE_STATES=shipped FORMULA="$fix/formula.yaml" "$gate" "$fix/good/shipped-incomplete.txt" >/dev/null 2>&1
got=$?
if [ "$got" -eq 1 ]; then echo "PASS: custom done state gates 'shipped' (exit 1)"
else echo "FAIL: custom done state gates 'shipped' (want 1, got $got)"; rc=1; fi

[ "$rc" -eq 0 ] && echo "All required-phases self-tests passed." || echo "required-phases self-tests FAILED."
exit "$rc"
