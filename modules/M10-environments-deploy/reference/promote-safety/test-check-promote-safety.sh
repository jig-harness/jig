#!/usr/bin/env bash
# Self-test for check-promote-safety.sh. Asserts: safe deploy workflows pass,
# unsafe ones fail per mode ((a) auto-push, (b) mutable ref), a non-prod deploy
# and a missing dir pass, and each file scores on its own. CI runs it so the
# promotion-safety gate can't silently stop catching.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-promote-safety.sh"
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

grep_out() { # <label> <pattern> <file>
  if "$gate" "$3" 2>/dev/null | grep -Eq "$2"; then echo "PASS: $1"
  else echo "FAIL: $1 (missing /$2/)"; rc=1; fi
}

run_dir  0 "all safe workflows pass"          "$fix/safe"
run_dir  1 "unsafe workflows fail"            "$fix/unsafe"
run_dir  0 "missing workflows dir passes"     "$fix/none"

run_file 1 "auto-push prod is unsafe (a)"     "$fix/unsafe/auto-push-prod.yml"
run_file 1 "mutable branch ref unsafe (b)"    "$fix/unsafe/mutable-ref-prod.yml"
run_file 1 "latest image tag unsafe (b)"      "$fix/unsafe/latest-artifact-prod.yml"
# Regression: workflow_dispatch alongside push is NOT a gate on the push run.
run_file 1 "push+dispatch, no env, unsafe (a)" "$fix/unsafe/push-and-dispatch-prod.yml"
# Regression: a `verified` mention off the deploy line must not exempt (b).
run_file 1 "mutable ref + verified-mention (b)" "$fix/unsafe/mutable-ref-verified-mention.yml"
run_file 0 "manual + verified is safe"        "$fix/safe/manual-verified-deploy.yml"
run_file 0 "env-gated push + verified safe"   "$fix/safe/environment-gated-push.yml"
run_file 0 "non-prod (preview) deploy safe"   "$fix/safe/non-prod-deploy.yml"
# Precision guard: the fixes must not over-flag legitimate patterns.
run_file 0 "push+dispatch WITH environment safe" "$fix/safe/push-dispatch-env-verified.yml"
# A verified reference elsewhere in the deploy job does NOT clear a mutable ref
# the deploy command actually selects.
run_file 1 "mutable ref + in-job verified download still unsafe (b)" "$fix/unsafe/mutable-ref-with-verified-download.yml"
# Job-scoping: a gate / verified on ANOTHER job must not mask the deploy job.
run_file 1 "env on other job, prod job ungated (a)"  "$fix/unsafe/multijob-env-on-other-job.yml"
run_file 1 "verified in build, deploy ships main (b)" "$fix/unsafe/multijob-verified-in-build.yml"
run_file 0 "env on the deploy job itself is safe"    "$fix/safe/multijob-env-on-deploy.yml"
run_file 0 "mutable ref on a non-deploy job is safe" "$fix/safe/multijob-verified-in-deploy.yml"
# GitLab push rules (incl. job-level) count as firing on push.
run_file 1 "gitlab job-level push rule, ungated (a)" "$fix/unsafe/gitlab-push-rule-prod.yml"
run_file 0 "gitlab push rule WITH a gate is safe"    "$fix/safe/gitlab-manual-prod.yml"
# Flow-style GitHub push trigger, and a mutable ref passed as a --ref flag.
run_file 1 "flow-style on:{push} ungated (a)"        "$fix/unsafe/flow-style-push-prod.yml"
run_file 1 "quoted scalar on: \"push\" ungated (a)"  "$fix/unsafe/quoted-push-prod.yml"
run_file 1 "block-sequence on: - push ungated (a)"   "$fix/unsafe/block-seq-push-prod.yml"
run_file 1 "step-input environment is not a gate (a)" "$fix/unsafe/step-input-environment-prod.yml"
run_file 1 "mutable ref via --ref flag (b)"          "$fix/unsafe/deploy-ref-flag-main.yml"

# The finding text names the failure mode, so an operator can act on it.
grep_out "auto-push finding cites the gate"   "environment|manual" "$fix/unsafe/auto-push-prod.yml"
grep_out "mutable finding cites the ref"      "mutable ref"                      "$fix/unsafe/mutable-ref-prod.yml"

# An existing but UNREADABLE workflows dir must fail closed (exit 2), never pass
# empty. Skipped under root or if the OS still lets us read it.
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

[ "$rc" -eq 0 ] && echo "All promote-safety self-tests passed." || echo "promote-safety self-tests FAILED."
exit "$rc"
