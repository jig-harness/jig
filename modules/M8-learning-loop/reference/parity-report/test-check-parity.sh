#!/usr/bin/env bash
# Self-test for check-parity.sh. Asserts: clean tallies pass, a missed blocker
# fails, an empty file passes, a non-numeric row errors, and the precision math
# marks a high-precision reviewer promotable and a low-precision one not.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-parity.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <tallies-file>
  "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

grep_out() { # <label> <pattern> <tallies-file>
  if "$gate" "$3" 2>/dev/null | grep -Eq "$2"; then echo "PASS: $1"
  else echo "FAIL: $1 (missing /$2/)"; rc=1; fi
}

run 0 "clean tallies pass"            "$fix/clean.tsv"
run 1 "missed blocker fails"          "$fix/missed.tsv"
run 0 "empty tallies pass"            "$fix/empty.tsv"
run 2 "non-numeric row errors"        "$fix/bad-row.tsv"
run 2 "extra column errors"           "$fix/extra-column.tsv"
run 2 "duplicate reviewer errors"     "$fix/duplicate-reviewer.tsv"
run 2 "missing tallies file errors"   "$fix/does-not-exist.tsv"

# MIN_PRECISION is validated before any tally is scored.
run_env() { # <expected-exit> <label> <MIN_PRECISION>
  MIN_PRECISION="$3" "$gate" "$fix/clean.tsv" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}
run_env 2 "out-of-range threshold errors" "-1"
run_env 2 "above-one threshold errors"    "1.5"
run_env 2 "non-numeric threshold errors"  "high"
run_env 0 "boundary threshold 1 is valid" "1"

# precision math: 47/(47+3)=0.94 >= 0.90 promotable; 20/(20+10)=0.67 not.
grep_out "high precision is promotable"  "shadow.*promotable=yes"  "$fix/clean.tsv"
grep_out "low precision is not promotable" "vendor-bot.*promotable=no" "$fix/clean.tsv"

[ "$rc" -eq 0 ] && echo "All parity-report self-tests passed." || echo "parity-report self-tests FAILED."
exit "$rc"
