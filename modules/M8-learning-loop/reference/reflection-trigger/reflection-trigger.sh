#!/usr/bin/env bash
# Reflection trigger: fire session reflection on an observable, and write the
# measurement that made it fire into the record.
#
# "Reflect when the session felt hard" reliably under-fires — the sessions with
# the most to say are the ones that end tired and late. So this reads the
# strongest observable available: how many review rounds a change took to
# converge (M7's review-convergence gate emits exactly that line). A change that
# needed many rounds is rarely a noisy reviewer; it usually means the scaffolding
# under-served it, and each of those is a lever this module's flywheel consumes.
#
# Two properties make the trigger work, and both are mechanical here rather than
# left to habit:
#
#   * It fires AT CONVERGENCE, not afterwards. Only a `CONVERGED` decision line
#     fires; the detail is richest at the moment the loop ends and decays fast
#     once the session closes. A prompt that arrives the next day gets a summary.
#   * The record CARRIES THE MEASUREMENT. The tool writes `change:` and `rounds:`
#     itself, so the inbox can answer "which changes fought the scaffolding
#     hardest" — which is the question that ranks the levers. A reflection entry
#     nobody can aggregate is an anecdote.
#
# Input: a file holding M7's convergence decision line, e.g.
#     CONVERGED round=5 open_threads=0 reviewers=2/2 pr_state=open
#
# Environment:
#     CHANGE           required — the change identifier (PR number, branch, ticket
#                      key). This is the aggregation key; there is no useful default
#     INBOX            required — path to the reflection inbox to append to. It must
#                      already exist (copy templates/reflection-inbox.md): creating
#                      one on demand means a typo'd path silently swallows records
#     ROUND_THRESHOLD  rounds at or above which to fire (default 3). A local
#                      calibration — set it where it fires on the genuinely hard
#                      reviews and not on ordinary ones, and keep it adjustable
#     ARCHIVE          optional — a file processed inbox entries are moved to. The
#                      dedup guard reads it too, so archiving (rather than
#                      deleting) keeps a retry from re-appending an old record
#     LOCK_TIMEOUT     seconds to wait for the inbox lock (default 30). The
#                      check-and-append is serialized; see below
#
# Exit codes (mirroring M7's convergence gate — a skip is NOT a failure):
#     0  PROMPT  — threshold reached; run reflection. Either a record was appended,
#                  or an earlier record for this change is still unfilled and needs
#                  finishing (no second record is written in that case)
#     3  SKIP    — nothing to do (not converged yet, under threshold, or already
#                  recorded AND filled in for this change and round count)
#     2  usage / format error
#
# On re-prompting: an unfilled record cannot be told apart from one another process
# wrote a moment ago, so two invocations racing on the same change may both prompt.
# That is the deliberate direction to err in — the record count, which is what the
# ranking reads, stays at one either way, whereas the opposite error (treating an
# abandoned stub as done) suppresses that change's reflection permanently.
#
# Wire it so a skip cannot fail the job — but so ONLY a skip is forgiven. A bare
# `if trigger; then …; fi` also swallows exit 2, which means a malformed decision
# file, a lock failure or a failed write silently disables reflection with nothing
# reporting it:
#     CHANGE=$PR INBOX=docs/reflection-inbox.md ARCHIVE=docs/reflection-archive.md \
#       ./reflection-trigger.sh decision.txt && rc=0 || rc=$?
#     case "$rc" in
#       0) <run your runtime's reflect command> ;;
#       3) : ;;                                  # ordinary review, nothing to do
#       *) echo "reflection trigger failed ($rc)" >&2; exit "$rc" ;;
#     esac
#
# Note what this does NOT decide: whether the rounds were the scaffolding's fault.
# "The reviewer was wrong repeatedly" is itself a finding, and routes to the
# reviewer's config or its eval corpus rather than to the instruction files. That
# judgement is the reflection's job; the trigger only guarantees it gets asked.
#
# Usage:
#   CHANGE=PR-482 INBOX=docs/reflection-inbox.md ./reflection-trigger.sh decision.txt
#   CHANGE=PR-482 INBOX=inbox.md DECISION=decision.txt ROUND_THRESHOLD=4 ./reflection-trigger.sh
set -u
DECISION="${1:-${DECISION:-}}"
CHANGE="${CHANGE:-}"
INBOX="${INBOX:-}"
ROUND_THRESHOLD="${ROUND_THRESHOLD:-3}"
LOCK_TIMEOUT="${LOCK_TIMEOUT:-30}"
ARCHIVE="${ARCHIVE:-}"

[ -n "$DECISION" ] || { echo "ERROR: no decision file given (arg or DECISION=)" >&2; exit 2; }
[ -f "$DECISION" ] || { echo "ERROR: decision file not found: $DECISION" >&2; exit 2; }
[ -n "$CHANGE" ] || { echo "ERROR: CHANGE is required (the aggregation key — a PR number, branch, or ticket key)" >&2; exit 2; }
[ -n "$INBOX" ] || { echo "ERROR: INBOX is required (path to the reflection inbox)" >&2; exit 2; }
[ -f "$INBOX" ] || { echo "ERROR: inbox not found: $INBOX (copy templates/reflection-inbox.md; this script will not create it)" >&2; exit 2; }
# A configured ARCHIVE is part of the duplicate census, so a typo'd or unreadable one
# must not be skipped: it would silently shrink the census and let an already-processed
# change be recorded again. Unset means "no archive"; set-but-unusable is an error.
if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] && [ -r "$ARCHIVE" ] || {
    echo "ERROR: ARCHIVE is set but is not a readable regular file: $ARCHIVE" >&2
    echo "       (it is part of the duplicate census — skipping it would double-count a processed change)" >&2
    exit 2; }
fi

# [$INBOX may be a symlink.] `cp` reads through it but `mv` would REPLACE the link
# with a regular file, leaving the canonical inbox untouched while this script
# reports success — two inboxes, and readers split between them. Resolve to the
# real path before anything writes. Bounded, so a symlink cycle errors instead of
# looping.
links=0
while [ -L "$INBOX" ]; do
  links=$((links + 1))
  [ "$links" -le 16 ] || { echo "ERROR: too many symlink levels for INBOX: $INBOX" >&2; exit 2; }
  target=$(readlink "$INBOX") || { echo "ERROR: cannot read symlink $INBOX" >&2; exit 2; }
  case "$target" in
    /*) INBOX="$target" ;;
    *)  INBOX="$(dirname "$INBOX")/$target" ;;
  esac
done
[ -f "$INBOX" ] || { echo "ERROR: inbox symlink does not resolve to a file: $INBOX" >&2; exit 2; }

# The change id lands in a record header and is matched back out of the inbox, so
# keep it a plain identifier rather than a sentence.
[[ "$CHANGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/#@-]*$ ]] || { echo "ERROR: CHANGE must be a plain identifier, got '$CHANGE'" >&2; exit 2; }
# A threshold of 0 would fire on every change, which is the noise that gets a
# reflection habit switched off — the failure mode this trigger exists to avoid.
[[ "$ROUND_THRESHOLD" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: ROUND_THRESHOLD must be an integer >= 1, got '$ROUND_THRESHOLD'" >&2; exit 2; }
[[ "$LOCK_TIMEOUT" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "ERROR: LOCK_TIMEOUT must be a non-negative integer (seconds), got '$LOCK_TIMEOUT'" >&2; exit 2; }

# Parse ONE COMPLETE M7 record, strictly. Loose parsing is dangerous here in a
# way it is not elsewhere, because this script appends durable evidence that a
# ranking is later built from:
#   * `CONVERGED round=5` on its own is not an M7 convergence record. Accepting
#     it means anything that happens to start with the right word can fire the
#     trigger and write a record nothing produced.
#   * A file holding a stale `CONVERGED …` above the current `ABORT …` would fire
#     on the stale line if we took the first and ignored the rest — recording a
#     convergence for a loop that was actually orphaned.
# So: exactly one non-comment line, matching the full shape the sibling gate
# emits. Anything else is a producer bug, and a producer bug must not become an
# inbox entry.
records=$(grep -Ev '^[[:space:]]*(#|$)' "$DECISION")
count=$(printf '%s\n' "$records" | grep -c . || true)
if [ "$count" -ne 1 ]; then
  echo "ERROR: expected exactly one decision record in $DECISION, found $count" >&2
  echo "       (a stale record above a current one would otherwise fire on the stale one)" >&2
  exit 2
fi
if [[ ! "$records" =~ ^(CONVERGED|WORK|WAIT|ABORT)" "round=([1-9][0-9]*)" "open_threads=(0|[1-9][0-9]*)" "reviewers=(0|[1-9][0-9]*)/(0|[1-9][0-9]*)" "pr_state=(open|merged|closed)$ ]]; then
  echo "ERROR: not a complete M7 convergence record: $records" >&2
  echo "       want: <CONVERGED|WORK|WAIT|ABORT> round=<n> open_threads=<n> reviewers=<n>/<n> pr_state=<open|merged|closed>" >&2
  exit 2
fi
decision="${BASH_REMATCH[1]}"
round="${BASH_REMATCH[2]}"
open_threads="${BASH_REMATCH[3]}"
reported="${BASH_REMATCH[4]}"
expected="${BASH_REMATCH[5]}"
record_pr_state="${BASH_REMATCH[6]}"

# SHAPE IS NOT AGREEMENT. The regex above proves the fields are M7-shaped; it does
# not prove the decision follows from them. `CONVERGED round=5 open_threads=2
# reviewers=1/2 pr_state=merged` is well-formed and self-contradictory — the
# authoritative gate would have emitted ABORT for it — and accepting it would
# record a convergence that never happened. For a script whose output is durable
# ranking evidence built from a file it did not produce, "looks right" is not the
# bar: re-derive the decision from the fields and insist the record agrees.
#
# These are exactly the gate's own precedence rules (liveness, then work in hand,
# then settling), which is what makes disagreement provable rather than a matter
# of taste.
case "$expected" in 0) echo "ERROR: record names zero reviewers, so it cannot describe a settled round: $records" >&2; exit 2 ;; esac
[ "$reported" -le "$expected" ] || { echo "ERROR: record reports more reviewers than it expects ($reported/$expected): $records" >&2; exit 2; }

if [ "$record_pr_state" = open ]; then
  if   [ "$open_threads" -gt 0 ];              then derived=WORK
  elif [ "$reported" -lt "$expected" ];        then derived=WAIT
  else                                              derived=CONVERGED
  fi
else
  derived=ABORT
fi
if [ "$decision" != "$derived" ]; then
  echo "ERROR: record says $decision but its own fields say $derived: $records" >&2
  echo "       (open_threads=$open_threads reviewers=$reported/$expected pr_state=$record_pr_state)" >&2
  exit 2
fi

skip() { printf 'SKIP change=%s rounds=%s threshold=%s\n' "$CHANGE" "$round" "$ROUND_THRESHOLD"; printf '%s\n' "$1" >&2; exit 3; }

if [ "$decision" != CONVERGED ]; then
  skip "Decision is $decision, not CONVERGED — reflection fires at convergence, when the detail is still there."
fi
if [ "$round" -lt "$ROUND_THRESHOLD" ]; then
  skip "Converged in $round round(s), under the threshold of $ROUND_THRESHOLD — an ordinary review."
fi
# The loop may run this step more than once for the same change (a CI re-run, a
# resumed session) — and, crucially, more than once AT ONCE. The duplicate check
# and the append have to be one indivisible operation: two concurrent runs that
# both pass the check and both append double-count the change in exactly the
# ranking the measurement exists to produce.
#
# The lock is a SYMLINK whose target is the holder's PID — the same technique as
# M12's resource lock, and for the same reason: creating a symlink is atomic on
# POSIX and fails if the name exists, so ownership and owner-identity are
# established in one step. There is no "won the lock but has not recorded its
# owner yet" window, which is what makes a crashed holder's lock safe to reclaim
# (its PID is gone) without ever tearing one out from under a live holder.
#
# Note this does NOT bypass under CI, unlike M12's wrapper — but be precise about
# what it therefore covers. A PID-keyed symlink serializes processes that SHARE A
# FILESYSTEM: several agents in one workspace, a re-run on the same runner, a
# resumed session. It does NOT serialize two isolated CI runners, which each have
# their own checkout and so their own `$INBOX.lock`; both acquire, both append,
# both prompt.
#
# The cross-runner guard is the one already in the workflow: the inbox is
# git-tracked, so the second job's push loses the race and has to rebase — and on
# the retry this script finds the marker and skips. For anything the PROMPT then
# CAUSES (an issue, a post, a message), key it idempotently on `change`+`rounds`
# rather than trusting that reflection ran once. See ../../mappings.md.
lock="$INBOX.lock"
lock_error=""

# `$INBOX` is caller-selected, so `$INBOX.lock` may already hold something this
# script did not create and has no business touching. Fail closed: a lock helper
# that deletes unrelated data to recover is a worse bug than the one it recovers
# from. (M12's machine-wide lock lives under a path it owns, which is why it can
# afford to clear leftovers; this one cannot.)
if [ -e "$lock" ] && [ ! -L "$lock" ]; then
  echo "ERROR: lock path exists and is not a symlink: $lock" >&2
  echo "       refusing to remove it — inspect and clear it yourself" >&2
  exit 2
fi

# Reclaim a dead holder's lock UNDER AN ATOMIC GUARD, re-reading the holder while
# the guard is held. Without the guard, two triggers can both read the same stale
# PID; the first removes it and acquires, and the second then removes the FIRST's
# live lock on the strength of its earlier observation — both go on to append,
# defeating serialization precisely during the concurrent CI reruns this exists
# for.
# NO AUTOMATIC STALE-LOCK RECLAMATION. The previous version reclaimed a lock whose
# holder PID was gone, behind a guard, and the guard needed a guard: two processes
# reading the same dead owner could each remove what the other had just created, and
# then one could remove a lock the other had legitimately reacquired — concurrent
# appends, which is the whole thing the lock exists to prevent.
#
# That is not a bug to patch, it is the shape of the problem: reclaiming safely needs
# compare-and-swap, and POSIX shell has atomic *create* (`ln -s`) but no atomic
# *replace-if-unchanged*. Every PID-liveness scheme is a read followed by a delete,
# with a window in between.
#
# So this waits, bounded, and then fails with something a person can act on. A stale
# lock costs one clear error and one `rm`; a subtly wrong reclaim costs a duplicated
# record that nothing reports. The lock is also released on EXIT/INT/TERM, so a
# leftover means a SIGKILL or a crashed machine — rare, and worth a human look.
acquire_inbox() {
  local waited=0 holder
  while :; do
    # `ln -s TARGET DIR` is a documented form: if $lock is a directory, this
    # SUCCEEDS by creating $lock/$$ and we would wrongly believe we hold the
    # lock. So a zero exit is not the acquisition test — owning the path is.
    if ln -s "$$" "$lock" 2>/dev/null; then
      if [ -L "$lock" ] && [ "$(readlink "$lock" 2>/dev/null)" = "$$" ]; then return 0; fi
      rm -f "$lock/$$" 2>/dev/null || true    # undo the stray inner link
      lock_error="lock path is a directory: $lock"
      return 1
    fi
    if [ -e "$lock" ] && [ ! -L "$lock" ]; then
      lock_error="lock path exists and is not a symlink: $lock (refusing to remove it)"
      return 1
    fi
    holder=$(readlink "$lock" 2>/dev/null) || holder=""
    if [ "$waited" -ge "$LOCK_TIMEOUT" ]; then
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
        lock_error="stale lock: $lock names PID $holder, which is gone. Remove it and re-run:
       rm -f $lock"
      else
        lock_error="could not lock $INBOX within ${LOCK_TIMEOUT}s (held by PID ${holder:-unknown})"
      fi
      return 1
    fi
    sleep 1; waited=$((waited + 1))
  done
}
release_inbox() { # only tear down a lock we still hold — a reclaim may have moved it on
  [ "$(readlink "$lock" 2>/dev/null)" = "$$" ] && rm -f "$lock" 2>/dev/null || true
}
acquire_inbox || { echo "ERROR: $lock_error" >&2; exit 2; }
# EXIT does the cleanup. INT/TERM must also STOP: releasing the lock and then
# carrying on into the append would reopen the very race the lock closes.
trap release_inbox EXIT
trap 'release_inbox; exit 130' INT
trap 'release_inbox; exit 143' TERM

# The dedup marker is looked for in the inbox AND in the archive, if one is
# configured. The inbox is worked down over time — entries leave once they become
# a lever — so the inbox alone is only a guard against a retry that arrives before
# anyone processed the entry. Move processed records to ARCHIVE rather than
# deleting them and the guard keeps holding; delete them and a later retry will
# re-append the same reflection, inflating the change in the ranking that the
# measurement exists to produce.
marker="<!-- reflection: $CHANGE rounds=$round -->"

# A record still carrying its `- disposition: <…>` placeholder means this trigger
# fired but the reflection never got written — the reflect command failed, or the
# session ended first. Treating that as "already recorded" is a trap: the marker
# suppresses every later attempt, so the change is permanently represented in the
# inbox by an empty stub. `disposition` is the completion marker because filling it
# is the step that turns a reflection into a lever, a reviewer-config change, or an
# explicit no-action.
record_is_pending() { # <file> -> 0 if this change's record is still a placeholder
  awk -v m="$marker" '
    index($0, m) { inrec = 1; next }
    inrec && /^## /  { exit }
    inrec            { print }
  ' "$1" | grep -q '^- disposition: <'
}

for haystack in "$INBOX" ${ARCHIVE:+"$ARCHIVE"}; do
  grep -Fq "$marker" "$haystack" || continue
  # An ARCHIVE hit is processed by definition — that is what archiving means.
  if [ "$haystack" = "$INBOX" ] && record_is_pending "$haystack"; then
    printf 'PROMPT change=%s rounds=%s threshold=%s\n' "$CHANGE" "$round" "$ROUND_THRESHOLD"
    printf 'An unfilled record for %s is already in %s — reflection never completed. Re-prompting; fill that record in rather than adding another.\n' \
      "$CHANGE" "$INBOX" >&2
    exit 0
  fi
  skip "Already recorded for $CHANGE at $round round(s) (in $haystack)."
done

# A partial record is worse than no record, and staging alone does not prevent one:
# `cat staged >> inbox` can still write the marker and then fail before the
# `disposition` placeholder, at which point the marker satisfies the next run's
# dedup guard while `record_is_pending` reads the truncated record as *complete* —
# SKIP forever, evidence lost. So build the WHOLE replacement inbox beside the real
# one and `mv` it into place: rename within a directory is atomic, so the inbox only
# ever holds the old content or the complete new content, never a prefix of it.
#
# `cp -p` first (rather than writing a fresh file) keeps the inbox's mode and any
# content this run did not author.
staged="$INBOX.staged.$$"
# `-p` matters: plain `cp` creates the staged file through the umask, so a
# group-writable 0664 inbox would come back 0644 and the rename would install that
# narrower mode — the first reflection quietly locking other users out of a shared
# inbox, while the comment below claims the mode is retained.
if ! cp -p "$INBOX" "$staged" 2>/dev/null; then
  rm -f "$staged" 2>/dev/null || true
  echo "ERROR: could not stage a replacement for $INBOX (disk full? quota? read-only directory?)" >&2
  exit 2
fi
if ! {
  printf '\n## %s — converged in %s rounds (threshold %s)\n\n' "$CHANGE" "$round" "$ROUND_THRESHOLD"
  printf '%s\n\n' "$marker"
  printf -- '- change: %s\n' "$CHANGE"
  printf -- '- rounds: %s\n' "$round"
  printf -- '- levers: <what under-served this change — an instruction that did not land, a\n'
  printf -- '  rule the reviewer had to teach twice, a convention that should be mechanised,\n'
  printf -- '  a reviewer config that let a known class through>\n'
  printf -- '- disposition: <lever id, or `reviewer-config` / `eval-corpus` if the reviewer\n'
  printf -- '  was the one that was wrong repeatedly>\n'
} >> "$staged" 2>/dev/null; then
  rm -f "$staged" 2>/dev/null || true
  echo "ERROR: could not write the reflection record (disk full? quota?)" >&2
  exit 2
fi
# The atomic step. A failure here leaves the ORIGINAL inbox untouched — no marker,
# so the next run retries cleanly rather than skipping on half a record.
if ! mv "$staged" "$INBOX" 2>/dev/null; then
  rm -f "$staged" 2>/dev/null || true
  echo "ERROR: could not install the updated $INBOX (left unchanged; nothing was recorded)" >&2
  exit 2
fi

printf 'PROMPT change=%s rounds=%s threshold=%s\n' "$CHANGE" "$round" "$ROUND_THRESHOLD"
printf 'Recorded in %s — now run reflection while the detail is still there.\n' "$INBOX" >&2
