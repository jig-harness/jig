#!/usr/bin/env bash
# Self-test for check-threads-resolved.sh. Asserts: an all-terminal export
# passes, an open thread fails, a trail-less rejection/deferral fails, an
# unknown state fails, an empty export passes, and a missing file errors.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-threads-resolved.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <states-file>
  "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run 0 "all terminal + trail passes"      "$fix/clean.txt"
run 1 "open thread fails"                "$fix/open.txt"
run 1 "trail-less resolution fails"      "$fix/no-reason.txt"
run 1 "addressed w/o fix ref fails"      "$fix/no-fix-ref.txt"
run 1 "unknown state fails"              "$fix/unknown.txt"
run 0 "empty export passes"              "$fix/empty.txt"
run 2 "missing states file errors"       "$fix/does-not-exist.txt"

[ "$rc" -eq 0 ] && echo "All comment-resolution self-tests passed." || echo "comment-resolution self-tests FAILED."
exit "$rc"
