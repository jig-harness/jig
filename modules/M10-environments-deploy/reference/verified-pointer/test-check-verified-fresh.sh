#!/usr/bin/env bash
# Self-test for check-verified-fresh.sh. Asserts: a fresh pointer passes, a
# pointer past either threshold stalls, at-threshold is fresh, bad/absent input
# and bad thresholds error, and both the file and env input paths work. CI runs
# it so the watchdog can't silently stop watching.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-verified-fresh.sh"
fix="$here/fixtures"
rc=0

run_file() { # <expected-exit> <label> <input-file>
  "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run_env() { # <expected-exit> <label> <env-assignments...>
  local want="$1" label="$2"; shift 2
  env "$@" "$gate" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "PASS: $label (exit $got)"
  else echo "FAIL: $label (want $want, got $got)"; rc=1; fi
}

grep_out() { # <label> <pattern> <env-assignments...>
  local label="$1" pat="$2"; shift 2
  if env "$@" "$gate" 2>/dev/null | grep -Eq "$pat"; then echo "PASS: $label"
  else echo "FAIL: $label (missing /$pat/)"; rc=1; fi
}

# ---- file-driven fixtures --------------------------------------------------
run_file 0 "fresh pointer passes"              "$fix/fresh.txt"
run_file 0 "at-threshold is fresh"             "$fix/boundary.txt"
run_file 1 "too far behind stalls"             "$fix/stalled-behind.txt"
run_file 1 "too old stalls"                    "$fix/stalled-age.txt"
run_file 2 "non-numeric value errors"          "$fix/bad-value.txt"
run_file 2 "unknown key errors"                "$fix/unknown-key.txt"
run_file 2 "duplicate key errors (no mask)"    "$fix/duplicate-key.txt"
run_file 2 "out-of-range huge value errors"    "$fix/huge-value.txt"
run_file 2 "no observation errors"             "$fix/empty.txt"
run_file 2 "missing input file errors"         "$fix/does-not-exist.txt"

# ---- env-driven observations ----------------------------------------------
run_env 0 "env fresh (behind+age) passes"      BEHIND=3 AGE_SECONDS=3600
run_env 0 "env behind-only fresh passes"       BEHIND=5
run_env 1 "env behind-only stalls"             BEHIND=999
run_env 1 "env age-only stalls"                AGE_SECONDS=999999
run_env 2 "env no observation errors"          MAX_BEHIND=20

# ---- threshold validation (before any scoring) ----------------------------
run_env 2 "negative MAX_BEHIND errors"         MAX_BEHIND=-1 BEHIND=1
run_env 2 "non-numeric MAX_BEHIND errors"      MAX_BEHIND=lots BEHIND=1
run_env 2 "negative MAX_AGE_SECONDS errors"    MAX_AGE_SECONDS=-5 AGE_SECONDS=1
run_env 0 "custom thresholds honored (fresh)"  MAX_BEHIND=100 BEHIND=50
run_env 1 "custom thresholds honored (stall)"  MAX_BEHIND=2 BEHIND=3

# ---- message surface -------------------------------------------------------
grep_out "stall message pages/heals"  "STALLED.*page|heal"  BEHIND=999
grep_out "fresh message says fresh"   "fresh"               BEHIND=1

[ "$rc" -eq 0 ] && echo "All verified-pointer self-tests passed." || echo "verified-pointer self-tests FAILED."
exit "$rc"
