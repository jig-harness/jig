#!/usr/bin/env bash
# Self-test for check-round-converged.sh. Asserts each of the four decisions and
# the format errors, and — the cases worth having a test for at all — the three
# ways a loop stops when it should not: a reviewer still running, a PR that merged
# mid-loop, and a bot counted twice because the producer summed signals instead of
# naming reviewers.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-round-converged.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <status-file>
  "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

decision() { # <label> <expected-decision> <status-file>
  local got
  got=$("$gate" "$3" 2>/dev/null | awk '{print $1}')
  if [ "$got" = "$2" ]; then echo "PASS: $1"
  else echo "FAIL: $1 (want $2, got '${got:-<none>}')"; rc=1; fi
}

run 0 "settled + nothing open converges"   "$fix/converged.txt"
run 1 "open threads mean more work"        "$fix/threads-open.txt"
run 3 "unsettled round waits"              "$fix/reviewer-pending.txt"
run 4 "merged PR aborts"                   "$fix/pr-merged.txt"
run 4 "closed PR aborts"                   "$fix/pr-closed.txt"
run 2 "missing key errors"                 "$fix/missing-key.txt"
run 2 "unknown key errors"                 "$fix/unknown-key.txt"
run 2 "non-numeric count errors"           "$fix/non-numeric.txt"
run 2 "unknown pr_state errors"            "$fix/bad-state.txt"
run 2 "missing status file errors"         "$fix/does-not-exist.txt"
# `round` is 1-based; a leading zero is octal to bash and would kill the
# comparisons outright, leaving a control-flow gate emitting no decision at all.
run 2 "a zeroth round errors"              "$fix/round-zero.txt"
run 2 "a zero-padded count errors"         "$fix/leading-zero.txt"
# Presence is tracked separately from value, so an empty first declaration is still
# a declaration. Without these four the check could regress to value-based
# duplicate detection and the paired self-test would not notice.
run 2 "a key declared with no value errors"           "$fix/empty-value.txt"
for key in pr_state open_threads round; do
  run 2 "an empty-then-duplicate $key errors"         "$fix/empty-then-dup-$key.txt"
done
# Reviewers are identities, so the producer cannot fudge the settled count.
run 2 "a repeated reviewer identity errors" "$fix/duplicate-reviewer.txt"
run 2 "naming no reviewer at all errors"    "$fix/no-reviewers.txt"
run 2 "a reviewer with no state errors"     "$fix/bad-reviewer-line.txt"
run 2 "an unknown reviewer state errors"    "$fix/bad-reviewer-state.txt"

# The whole reason this gate exists: zero open threads is not the stop condition.
decision "pending reviewer is not convergence" WAIT      "$fix/reviewer-pending.txt"
decision "settled round is convergence"        CONVERGED "$fix/converged.txt"
# Liveness outranks everything — a merged PR must not report WORK on its threads.
decision "merged PR outranks open threads"     ABORT     "$fix/pr-merged.txt"
# Work in hand outranks an unsettled round: there is something to fix either way.
decision "open threads outrank an unsettled round" WORK  "$fix/work-before-wait.txt"
# A bot leaving two artifacts behind is one reviewer. Counting signals instead of
# identities reports 2/2 here and converges while a human has not looked yet.
decision "a two-artifact bot is one reviewer, so this waits" WAIT "$fix/double-counted-bot.txt"

reported_over() { # the settled fraction must reflect identities, not signal count
  local got
  got=$("$gate" "$fix/double-counted-bot.txt" 2>/dev/null | grep -o 'reviewers=[0-9]*/[0-9]*')
  if [ "$got" = "reviewers=1/2" ]; then echo "PASS: the settled fraction counts identities ($got)"
  else echo "FAIL: the settled fraction counts identities (got '$got', want reviewers=1/2)"; rc=1; fi
}
reported_over

# The WAIT reasoning has to name who is still out, or the loop's driver cannot act.
if "$gate" "$fix/reviewer-pending.txt" 2>&1 >/dev/null | grep -q 'still pending: alice'; then
  echo "PASS: WAIT names the reviewers still out"
else echo "FAIL: WAIT names the reviewers still out"; rc=1; fi

# The decision line is the M8 reflection trigger's input, so the round count has
# to survive onto stdout in a parseable form.
if "$gate" "$fix/converged.txt" 2>/dev/null | grep -Eq '^CONVERGED round=3 .*reviewers=2/2'; then
  echo "PASS: decision line carries the round count for downstream consumers"
else
  echo "FAIL: decision line carries the round count for downstream consumers"; rc=1
fi

[ "$rc" -eq 0 ] && echo "All review-convergence self-tests passed." || echo "review-convergence self-tests FAILED."
exit "$rc"
