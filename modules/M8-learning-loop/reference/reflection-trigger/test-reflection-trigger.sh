#!/usr/bin/env bash
# Self-test for reflection-trigger.sh. Asserts the firing rule (converged, at or
# over threshold) and the two properties that make the record worth having: it
# carries the measurement that triggered it, and running the step twice for the
# same change does not double-count it in the ranking that measurement feeds.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
trigger="$here/reflection-trigger.sh"
fix="$here/fixtures"
rc=0
tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT

fresh_inbox() { local p="$tmp/inbox-$1.md"; printf '# Reflection inbox\n' > "$p"; printf '%s' "$p"; }

run() { # <expected-exit> <label> <decision-fixture> [inbox] [threshold]
  local inbox="${4:-$(fresh_inbox "$2")}" got
  CHANGE=PR-482 INBOX="$inbox" ROUND_THRESHOLD="${5:-3}" "$trigger" "$fix/$3" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run 0 "hard review fires"                 converged-hard.txt
run 3 "ordinary review skips"             converged-ordinary.txt
run 3 "mid-loop skips"                    work.txt
run 3 "aborted loop skips"                abort.txt
run 2 "decision line without a round errors" no-round.txt
run 2 "unrecognised decision errors"      bad-decision.txt
run 2 "no decision line errors"           empty.txt
run 2 "missing decision file errors"      does-not-exist.txt
# This script appends durable evidence, so a near-miss must not be good enough.
run 2 "an incomplete record errors"       partial-record.txt
run 2 "a stale record above a current one errors" multiple-records.txt
# Shape is not agreement: a well-formed record whose decision contradicts its own
# fields would launder a convergence that the authoritative gate never emitted.
run 2 "CONVERGED contradicted on every field errors" contradictory-converged.txt
run 2 "CONVERGED with open threads errors"           contradictory-converged-threads.txt
run 2 "CONVERGED with a pending reviewer errors"     contradictory-converged-pending.txt
run 2 "WORK with nothing to do errors"               contradictory-work.txt
run 2 "WAIT on a merged PR errors"                   contradictory-wait.txt
run 2 "ABORT on a live settled PR errors"            contradictory-abort.txt
run 2 "a record naming zero reviewers errors"        zero-reviewers.txt
run 2 "more reported than expected errors"           over-reported.txt

# The threshold is a local calibration, so it has to actually move the line.
run 3 "threshold above the round count skips" converged-hard.txt "$(fresh_inbox thresh-hi)" 6
run 0 "threshold at the round count fires"    converged-hard.txt "$(fresh_inbox thresh-eq)" 5
run 2 "a zero threshold errors"               converged-hard.txt "$(fresh_inbox thresh-0)"  0

env_err() { # <label> <var-assignments...> — a bad environment must error, not skip
  local label="$1"; shift
  local got
  env "$@" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq 2 ]; then echo "PASS: $label"
  else echo "FAIL: $label (want exit 2, got $got)"; rc=1; fi
}
env_err "missing CHANGE errors" "INBOX=$(fresh_inbox nochange)" "CHANGE="
env_err "missing INBOX errors"  "CHANGE=PR-482" "INBOX="
env_err "a sentence for CHANGE errors" "CHANGE=the auth PR" "INBOX=$(fresh_inbox badchange)"
env_err "a nonexistent inbox errors" "CHANGE=PR-482" "INBOX=$tmp/no-such-inbox.md"

# The record has to carry the measurement, or the inbox holds anecdotes.
inbox=$(fresh_inbox record)
CHANGE=PR-482 INBOX="$inbox" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
for pattern in '^- change: PR-482$' '^- rounds: 5$' '^- levers:' '^- disposition:'; do
  if grep -Eq "$pattern" "$inbox"; then echo "PASS: record carries /$pattern/"
  else echo "FAIL: record carries /$pattern/"; rc=1; fi
done

# Re-running the loop step must never write a second record. While the first
# record is still an unfilled stub it must RE-PROMPT: the reflect command may have
# died, and a marker that suppresses every retry would leave this change
# represented in the inbox forever by an empty placeholder.
CHANGE=PR-482 INBOX="$inbox" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
second=$?
count=$(grep -c '^- change: PR-482$' "$inbox")
if [ "$second" -eq 0 ] && [ "$count" -eq 1 ]; then echo "PASS: an unfilled record re-prompts without a second record"
else echo "FAIL: an unfilled record re-prompts without a second record (exit $second want 0, $count records want 1)"; rc=1; fi

# Once the disposition is filled in, the reflection is done and must stop firing.
sed_i() { sed "$1" "$2" > "$2.tmp" && mv "$2.tmp" "$2"; }
sed_i 's|^- disposition: <.*|- disposition: L-0042|' "$inbox"
CHANGE=PR-482 INBOX="$inbox" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
third=$?
count=$(grep -c '^- change: PR-482$' "$inbox")
if [ "$third" -eq 3 ] && [ "$count" -eq 1 ]; then echo "PASS: a filled-in record skips instead of double-counting"
else echo "FAIL: a filled-in record skips instead of double-counting (exit $third want 3, $count records want 1)"; rc=1; fi

# A later round for the same change IS new information and must be recorded.
CHANGE=PR-482 INBOX="$inbox" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
printf 'CONVERGED round=7 open_threads=0 reviewers=2/2 pr_state=open\n' > "$tmp/round7.txt"
CHANGE=PR-482 INBOX="$inbox" "$trigger" "$tmp/round7.txt" >/dev/null 2>&1
if [ "$(grep -c '^- change: PR-482$' "$inbox")" -eq 2 ]; then echo "PASS: a later round for the same change is recorded"
else echo "FAIL: a later round for the same change is recorded"; rc=1; fi

# The no-double-count guarantee has to hold under CONCURRENCY, not just on a
# re-run — two CI reruns or resumed sessions can reach the check at the same
# moment. A sequential test cannot see that, so fan out and count.
racers=8
inbox=$(fresh_inbox race)
pids=""
for i in $(seq 1 "$racers"); do
  CHANGE=PR-900 INBOX="$inbox" "$trigger" "$fix/converged-hard.txt" >"$tmp/race.$i.out" 2>&1 &
  pids="$pids $!"
done
fired=0
for p in $pids; do
  if wait "$p"; then fired=$((fired + 1)); fi
done
records=$(grep -c '^- change: PR-900$' "$inbox" || true)
# Exactly ONE RECORD is the invariant that matters — it is what the ranking counts.
# The prompt count is deliberately not pinned to 1: a stub another racer wrote a
# moment ago is indistinguishable from an abandoned one, so a loser may re-prompt.
# Erring that way is safe; erring the other way suppresses the change forever.
if [ "$records" -eq 1 ] && [ "$fired" -ge 1 ]; then
  echo "PASS: $racers concurrent runs write exactly one record ($fired prompted)"
else
  echo "FAIL: $racers concurrent runs write exactly one record (got $records records, $fired PROMPT)"; rc=1
fi
# A lock left behind would wedge every later run, so releasing is part of the contract.
if [ ! -e "$inbox.lock" ]; then echo "PASS: the inbox lock is released"
else echo "FAIL: the inbox lock is released (stale $inbox.lock)"; rc=1; fi

# There is no automatic stale-lock reclamation: it cannot be made race-free in
# POSIX shell. The contract is a bounded wait and then an ACTIONABLE error, which
# is what these two assert — a dead holder must not hang, and the message must name
# the file to remove.
stale=$tmp/stale.md
printf '# Reflection inbox\n' > "$stale"
ln -s 999999999 "$stale.lock"
out=$(CHANGE=PR-702 INBOX="$stale" LOCK_TIMEOUT=1 "$trigger" "$fix/converged-hard.txt" 2>&1)
sr=$?
if [ "$sr" -eq 2 ] && [ "$(grep -c '^- change:' "$stale")" -eq 0 ]; then
  echo "PASS: a stale lock fails bounded instead of hanging or appending"
else echo "FAIL: a stale lock fails bounded instead of hanging or appending (exit $sr)"; rc=1; fi
if printf '%s' "$out" | grep -q "rm -f $stale.lock"; then
  echo "PASS: the stale-lock error names the file to remove"
else echo "FAIL: the stale-lock error names the file to remove"; rc=1; fi
rm -f "$stale.lock"

# Once the stale lock is gone, the very next run must succeed — a clear failure is
# only acceptable if recovery is one command away.
CHANGE=PR-702 INBOX="$stale" LOCK_TIMEOUT=1 "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
if [ "$?" -eq 0 ] && [ "$(grep -c '^- change: PR-702$' "$stale")" -eq 1 ]; then
  echo "PASS: removing the stale lock is sufficient recovery"
else echo "FAIL: removing the stale lock is sufficient recovery"; rc=1; fi

# A configured ARCHIVE is part of the duplicate census, so a typo'd one must ERROR
# rather than be skipped — skipping it silently lets a processed change re-fire.
miss=$(fresh_inbox missarchive)
CHANGE=PR-706 INBOX="$miss" ARCHIVE="$tmp/no-such-archive.md" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
ar=$?
if [ "$ar" -eq 2 ] && [ "$(grep -c '^- change:' "$miss")" -eq 0 ]; then
  echo "PASS: a configured-but-missing ARCHIVE errors instead of shrinking the census"
else echo "FAIL: a configured-but-missing ARCHIVE errors instead of shrinking the census (exit $ar)"; rc=1; fi

# A symlinked inbox must be written THROUGH, not replaced: `mv` over the link would
# leave the canonical file untouched while reporting success.
mkdir -p "$tmp/sl"
printf '# Reflection inbox\n' > "$tmp/sl/real.md"
ln -s real.md "$tmp/sl/link.md"
CHANGE=PR-707 INBOX="$tmp/sl/link.md" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
if [ -L "$tmp/sl/link.md" ] && [ "$(grep -c '^- change: PR-707$' "$tmp/sl/real.md")" -eq 1 ]; then
  echo "PASS: a symlinked inbox is written through, not replaced"
else echo "FAIL: a symlinked inbox is written through, not replaced"; rc=1; fi

# The inbox mode must survive the rename, or the first reflection locks a shared
# inbox down to the writer's umask.
mode_inbox=$tmp/mode.md
printf '# Reflection inbox\n' > "$mode_inbox"; chmod 664 "$mode_inbox"
CHANGE=PR-708 INBOX="$mode_inbox" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
if [ -w "$mode_inbox" ] && [ "$(ls -l "$mode_inbox" | cut -c1-10)" = "-rw-rw-r--" ]; then
  echo "PASS: the inbox mode survives the atomic replace"
else echo "FAIL: the inbox mode survives the atomic replace (got $(ls -l "$mode_inbox" | cut -c1-10))"; rc=1; fi

# `$INBOX` is caller-selected, so `$INBOX.lock` can hold something this script did
# not create. It must fail closed rather than delete data it never acquired — and
# `ln -s TARGET DIR` succeeds by linking INSIDE a directory, so a zero exit from
# `ln` is not proof of ownership.
lock_path_case() { # <label> <setup-command...>
  local label="$1"; shift
  local li="$tmp/lockcase.md" got
  printf '# Reflection inbox\n' > "$li"
  rm -rf "$li.lock"; "$@" || true
  CHANGE=PR-700 INBOX="$li" LOCK_TIMEOUT=1 "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq 2 ] && [ -e "$li.lock" ] && [ "$(grep -c '^- change:' "$li")" -eq 0 ]; then
    echo "PASS: $label"
  else
    echo "FAIL: $label (exit $got, lock present: $([ -e "$li.lock" ] && echo yes || echo NO — it was deleted))"; rc=1
  fi
  rm -rf "$li.lock"
}
lock_path_case "a directory at the lock path errors and is preserved" mkdir "$tmp/lockcase.md.lock"
lock_path_case "a regular file at the lock path errors and is preserved" touch "$tmp/lockcase.md.lock"


# The inbox is worked down over time, so the dedup guard has to read the archive
# too — otherwise a retry re-appends a record whose entry was already processed.
arch_inbox=$(fresh_inbox archive)
archive="$tmp/archive.md"
CHANGE=PR-800 INBOX="$arch_inbox" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
mv "$arch_inbox" "$archive"                     # the entry was processed and filed
printf '# Reflection inbox\n' > "$arch_inbox"   # inbox back to empty
CHANGE=PR-800 INBOX="$arch_inbox" ARCHIVE="$archive" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
archived_rc=$?
CHANGE=PR-800 INBOX="$arch_inbox" "$trigger" "$fix/converged-hard.txt" >/dev/null 2>&1
unarchived_rc=$?
if [ "$archived_rc" -eq 3 ] && [ "$unarchived_rc" -eq 0 ]; then
  echo "PASS: ARCHIVE extends the dedup guard past a processed entry"
else
  echo "FAIL: ARCHIVE extends the dedup guard past a processed entry (with=$archived_rc want 3, without=$unarchived_rc want 0)"; rc=1
fi

[ "$rc" -eq 0 ] && echo "All reflection-trigger self-tests passed." || echo "reflection-trigger self-tests FAILED."
exit "$rc"
