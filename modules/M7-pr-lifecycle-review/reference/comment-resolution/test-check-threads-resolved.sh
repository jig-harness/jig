#!/usr/bin/env bash
# Self-test for check-threads-resolved.sh. Asserts: an all-terminal export
# passes (including a `moot` row), an open thread fails, a trail-less
# rejection/deferral fails, a trail-less `moot` fails, an undeclared verdict
# fails, an unknown state fails, an empty export passes, and a missing file
# errors.
#
# The nonblank-but-meaningless cases (`moot x`, `deferred later`) are the ones
# worth keeping: an entirely missing trail is the easy half, and a check that
# only tests the easy half will not notice the day it starts accepting anything.
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
run 1 "trail-less moot fails"            "$fix/no-reason-moot.txt"
run 1 "addressed w/o fix ref fails"      "$fix/no-fix-ref.txt"
run 1 "moot w/o superseding ref fails"   "$fix/bad-ref-moot.txt"
run 1 "deferred w/o follow-up ref fails" "$fix/bad-ref-deferred.txt"
run 1 "undeclared verdict fails"         "$fix/unclassified.txt"
run 1 "unknown state fails"              "$fix/unknown.txt"
run 0 "empty export passes"              "$fix/empty.txt"
run 2 "missing states file errors"       "$fix/does-not-exist.txt"

says() { # <label> <pattern> <states-file>
  if "$gate" "$3" 2>&1 | grep -Eq "$2"; then echo "PASS: $1"
  else echo "FAIL: $1 (missing /$2/)"; rc=1; fi
}
denies() { # <label> <pattern> <states-file> — the pattern must NOT appear
  if "$gate" "$3" 2>&1 | grep -Eq "$2"; then echo "FAIL: $1 (unexpected /$2/)"; rc=1
  else echo "PASS: $1"; fi
}

# An undeclared verdict must not be reported as a typo — the fix is a different
# one (write the verdict, vs. correct the word), so the message has to differ.
says   "undeclared verdict names the encoding, not a typo" "declares no verdict" "$fix/unclassified.txt"
denies "undeclared verdict is not reported as a typo"      "unknown state"       "$fix/unclassified.txt"
# The message has to name the closed set, not just say "unknown" — a resolver
# reading it needs to know which words are legal.
says "unknown state lists the closed vocabulary" \
     "unknown state 'resolveed' \(want: addressed\|rejected\|deferred\|moot\)" "$fix/unknown.txt"

# A tracker key IS a follow-up reference. Asserting only that the file passes
# would keep passing if this row regressed while another row carried it, so name
# the row: it must produce no FAIL line of its own.
denies "tracker key satisfies deferred (T-1003 does not fail)" "T-1003" "$fix/clean.txt"
says   "a clean export passes as a whole"                      "^OK"     "$fix/clean.txt"
# ...and the promise-shaped deferrals in the sibling fixture must each be named.
for row in T-6101 T-6102; do
  says "deferred without a reference names $row" "FAIL $row" "$fix/bad-ref-deferred.txt"
done

[ "$rc" -eq 0 ] && echo "All comment-resolution self-tests passed." || echo "comment-resolution self-tests FAILED."
exit "$rc"
