#!/usr/bin/env bash
# Self-test for adr-rules-check.sh. Exercises both rule shapes (deny-on-match,
# require-nearby), the exclude globs, and severity handling. CI runs it so the
# interpreter can't silently stop enforcing.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/adr-rules-check.sh"
fix="$here/fixtures"
export RULES="$fix/adr-rules.yaml"
rc=0

run() { # <expected-exit> <label> [STRICT=1] <files...>
  local want=$1 label=$2; shift 2
  local strict=0
  if [ "$1" = "--strict" ]; then strict=1; shift; fi
  STRICT="$strict" "$gate" "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "PASS: $label (exit $got)"
  else echo "FAIL: $label (want $want, got $got)"; rc=1; fi
}

run 0 "clean code passes"                          "$fix/clean/good.ts"
run 1 "deny-on-match (console.log) fails critical"  "$fix/bad/logging.ts"
run 0 "excluded test file is not checked"           "$fix/bad/logging.test.ts"
run 0 "require-nearby miss is a non-blocking warning" "$fix/bad/fetch.ts"
run 1 "warning fails under STRICT"                  --strict "$fix/bad/fetch.ts"

[ "$rc" -eq 0 ] && echo "All adr-rules-check self-tests passed." || echo "adr-rules-check self-tests FAILED."
exit "$rc"
