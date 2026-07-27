#!/usr/bin/env bash
# Self-test for check-branch-protection.sh. All cases run in --input mode
# against saved fixture JSON, so this never touches the network or `gh`.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$SCRIPT_DIR/check-branch-protection.sh"
FIXTURES="$SCRIPT_DIR/tests/fixtures/branch-protection"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

expect_exit() {  # expect_exit <fixture> <0|1> <label>
  local fixture=$1 want=$2 label=$3 got
  "$GATE" --input "$FIXTURES/$fixture" example/repo main >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then
    pass "$label"
  else
    fail "$label (expected exit $want, got $got)"
  fi
}

expect_contains() {  # expect_contains <fixture> <needle> <label>
  local fixture=$1 needle=$2 label=$3
  if "$GATE" --input "$FIXTURES/$fixture" example/repo main 2>&1 | grep -qF "$needle"; then
    pass "$label"
  else
    fail "$label (missing '$needle')"
  fi
}

expect_offline_no_origin() {  # expect_offline_no_origin <fixture> <label>
  local fixture=$1 label=$2 out got
  out=$(cd /tmp && "$GATE" --input "$FIXTURES/$fixture" 2>&1)
  got=$?
  if [ "$got" -eq 0 ] && ! printf '%s' "$out" | grep -q "could not parse an owner/repo"; then
    pass "$label"
  else
    fail "$label (exit $got: $out)"
  fi
}

echo "check-branch-protection.sh"
expect_exit "compliant.json"   0 "all-PASS fixture exits 0"
expect_exit "unprotected.json" 1 "unprotected fixture exits 1"
expect_exit "partial.json"     1 "partial fixture exits 1"
expect_exit "malformed.json"   2 "malformed JSON input exits 2"
expect_exit "wrong-type.json"  2 "non-object JSON input exits 2"
expect_exit "bad-types.json"   2 "wrong-typed fields (string contexts/review-count) exit 2"

expect_offline_no_origin "compliant.json" "offline --input works with no positional args and no github origin (run from /tmp)"

expect_contains "unprotected.json" "FAIL  required CI status check(s) configured" "unprotected fixture flags missing required checks"
expect_contains "unprotected.json" "FAIL  force-push disallowed" "unprotected fixture fails force-push (no default-closed shortcut)"
expect_contains "unprotected.json" "FAIL  branch deletion disallowed" "unprotected fixture fails deletion (no default-closed shortcut)"
expect_contains "unprotected.json" "0/7 controls satisfied" "unprotected fixture fails every absent control"
expect_contains "partial.json" "FAIL  required conversation resolution" "partial fixture flags conversation resolution"
expect_contains "partial.json" "FAIL  administrator enforcement" "partial fixture flags admin enforcement"
expect_contains "partial.json" "PASS  at least one required human review" "partial fixture still passes review count"
expect_contains "partial.json" "PASS  required status checks are strict" "partial fixture already sets strict mode"
expect_contains "partial.json" "release-bot" "partial fixture surfaces the bypass actor"
expect_contains "compliant.json" "7/7 controls satisfied" "compliant fixture reports 7/7"

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
