#!/usr/bin/env bash
# Self-test for check-todo-has-issue.sh — the paired test every grep gate
# ships with. Verifies the gate passes on clean fixtures, fails on bad ones,
# honors justified suppressions, and rejects reason-less ones.
#
# Usage: test-todo-has-issue.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$SCRIPT_DIR/check-todo-has-issue.sh"
FIXTURES="$SCRIPT_DIR/fixtures"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

expect_pass() {
  if SRC_DIR="$1" "$GATE" > /dev/null 2>&1; then
    pass "$2"
  else
    fail "$2 (expected exit 0, got non-zero)"
  fi
}

expect_fail() {
  if SRC_DIR="$1" "$GATE" > /dev/null 2>&1; then
    fail "$2 (expected non-zero exit, got 0)"
  else
    pass "$2"
  fi
}

echo "check-todo-has-issue.sh"
expect_pass "$FIXTURES/clean"  "passes on clean fixture (issue-referenced TODOs)"
expect_fail "$FIXTURES/bad"    "fails on bare TODO and on reason-less todo-exempt:"
expect_pass "$FIXTURES/exempt" "passes on justified todo-exempt: suppression"
expect_pass "$FIXTURES/does-not-exist" "passes when the scan root does not exist"

EMPTY=$(mktemp -d)
trap 'rm -rf "$EMPTY"' EXIT
expect_pass "$EMPTY" "passes on an empty scan root"

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
