#!/usr/bin/env bash
# Self-test for check-pr-target-safety.sh. Asserts: safe workflows pass, unsafe
# ones fail, a missing dir passes, and each individual unsafe/safe file scores
# on its own. CI runs it so the security gate can't silently stop catching.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-pr-target-safety.sh"
fix="$here/fixtures"
rc=0

run_dir() { # <expected-exit> <label> <workflows-dir>
  WORKFLOWS_DIR="$3" "$gate" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run_file() { # <expected-exit> <label> <file>
  "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run_dir  0 "all safe workflows pass"          "$fix/safe"
run_dir  1 "unsafe workflows fail"            "$fix/unsafe"
run_dir  0 "missing workflows dir passes"     "$fix/none"

run_file 1 "head-sha + run is unsafe"         "$fix/unsafe/head-sha-run.yml"
run_file 1 "fork repo + run is unsafe"        "$fix/unsafe/fork-repo-run.yml"
run_file 1 "folded-scalar ref + run unsafe"   "$fix/unsafe/folded-ref-run.yml"
run_file 1 "quoted run: key is unsafe"        "$fix/unsafe/quoted-run.yml"
run_file 1 "local ./ action is unsafe"        "$fix/unsafe/local-action-run.yml"
run_file 0 "base-only checkout is safe"       "$fix/safe/base-checkout-review.yml"
run_file 0 "plain pull_request is safe"       "$fix/safe/plain-pull-request.yml"
run_file 0 "labeler with no run: is safe"     "$fix/safe/labeler-data-only.yml"

# An existing but UNREADABLE workflows dir must fail closed (exit 2), never pass
# empty. Skipped under root (which ignores the permission bits) or if the OS
# still lets us read it.
if [ "$(id -u)" -ne 0 ]; then
  noread=$(mktemp -d)
  : > "$noread/wf.yml"
  chmod 000 "$noread"
  if ! find "$noread" -maxdepth 1 -name '*.yml' >/dev/null 2>&1; then
    run_dir 2 "unreadable workflows dir fails closed" "$noread"
  else
    echo "SKIP: unreadable-dir test (dir still scannable here)"
  fi
  chmod 755 "$noread"; rm -rf "$noread"
else
  echo "SKIP: unreadable-dir test (running as root)"
fi

[ "$rc" -eq 0 ] && echo "All pr-target-safety self-tests passed." || echo "pr-target-safety self-tests FAILED."
exit "$rc"
