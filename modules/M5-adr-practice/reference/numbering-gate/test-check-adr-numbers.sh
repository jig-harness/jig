#!/usr/bin/env bash
# Self-test for check-adr-numbers.sh. Asserts pass on unique numbers, fail on a
# collision, pass on a missing dir. CI runs it so the gate can't silently break.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-adr-numbers.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <adr-dir>
  ADR_DIR="$3" "$gate" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run 0 "unique ADR numbers pass"        "$fix/unique"
run 1 "duplicate ADR number fails"     "$fix/dupe"
run 0 "missing ADR dir passes"         "$fix/none"

[ "$rc" -eq 0 ] && echo "All numbering-gate self-tests passed." || echo "Numbering-gate self-tests FAILED."
exit "$rc"
