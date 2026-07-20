#!/usr/bin/env bash
# Self-test for check-metrics-wired.sh. Asserts a fully-wired registry passes, an
# empty registry passes, a TODO / empty / missing / placeholder source fails
# (exit 1), and a registry with no metrics: collection errors (exit 2). CI runs
# it so the no-dark-instruments gate can't silently break.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-metrics-wired.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <registry-file>
  REGISTRY="$3" "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

grep_out() { # <label> <pattern> <registry-file>
  if REGISTRY="$3" "$gate" "$3" 2>&1 | grep -Eq "$2"; then echo "PASS: $1"
  else echo "FAIL: $1 (missing /$2/)"; rc=1; fi
}

run 0 "fully-wired registry passes"    "$fix/good/metrics-registry.yaml"
run 0 "empty registry passes"          "$fix/empty-registry.yaml"
run 1 "TODO source fails"              "$fix/bad/todo-source.yaml"
run 1 "empty source fails"             "$fix/bad/empty-source.yaml"
run 1 "missing source fails"           "$fix/bad/missing-source.yaml"
run 1 "placeholder variants fail"      "$fix/bad/placeholder-variants.yaml"
run 1 "empty-list source is dark"      "$fix/bad/empty-list-source.yaml"
run 2 "no metrics collection errors"   "$fix/bad/no-metrics-key.yaml"
run 2 "scalar metrics value errors"    "$fix/bad/scalar-metrics.yaml"
run 2 "missing registry file errors"   "$fix/bad/does-not-exist.yaml"

# case-insensitivity and that the report names the dark metric
grep_out "names the dark TODO metric"    "DARK review-adoption-rate" "$fix/bad/todo-source.yaml"
grep_out "catches mixed-case DARK"       "DARK metric-b"             "$fix/bad/placeholder-variants.yaml"
grep_out "keeps the wired one wired"     "OK   metric-e"             "$fix/bad/placeholder-variants.yaml"

[ "$rc" -eq 0 ] && echo "All no-dark-instruments self-tests passed." || echo "no-dark-instruments self-tests FAILED."
exit "$rc"
