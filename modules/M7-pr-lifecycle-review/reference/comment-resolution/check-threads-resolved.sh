#!/usr/bin/env bash
# Unresolved-threads merge gate: no PR merges with an open review thread, and
# every non-fix resolution carries an audit trail.
#
# This is the comment-resolution loop (address / reject / defer / moot — see
# ../../templates/PR-LIFECYCLE.md) made mechanical. A forge's own branch
# protection can require "all threads resolved", but that is a bare boolean; it
# cannot tell an addressed thread from one a bot marked resolved with no
# reason. This gate reads a small, forge-exported states file so it can enforce
# the *trail*, not just the flag.
#
# Input: a states file, one thread per line, whitespace-separated:
#     <thread-id> <state> [reason / follow-up reference ...]
# States and their rule:
#     addressed   accepted, fixed in this PR           -> pass ONLY with a commit/change reference
#     rejected    finding is wrong / intended          -> pass ONLY with a reason (prose is enough)
#     deferred    accepted, filed as a follow-up       -> pass ONLY with a follow-up reference
#     moot        no longer applies; the code is gone  -> pass ONLY with a superseding reference
#     open        not yet terminal                     -> FAIL (blocks merge)
#     unclassified  resolved, but no verdict declared  -> FAIL (see below)
#     <other>     typo / unknown                       -> FAIL
#
# Three of the four terminal states make a claim ABOUT A CHANGE — "fixed here",
# "tracked there", "superseded by that" — so their trail has to name one: a
# commit sha, a `#123`, a tracker key like `ISSUE-482`, or a URL. Only `rejected`
# is a claim about the finding itself, where prose is the whole answer. Accepting
# any nonblank text for the other three fails open: `moot x` would pass, and
# `moot` is precisely the state that must not become the frictionless dismissal.
#
# `moot` is a distinct terminal state, not a polite `rejected`. Rejected asserts
# the reviewer was WRONG; moot asserts it may have been RIGHT about code that no
# longer exists. Where a learning loop mines these states (M8), collapsing the
# two feeds it false positives the reviewer never committed — so the distinction
# has to survive all the way into the export, not just into the reply prose.
#
# `unclassified` is what the exporter emits for a resolved thread whose reply
# declares no verdict (../../mappings.md § Encoding the declared verdict). It fails,
# with its own message, rather than being folded into a real state: "cannot tell"
# counted as a rejection is the same corruption as a `moot` counted as one.
#
# Blank lines and `# comments` are ignored. An empty file means zero threads
# (pass). Produce the file from your forge per ../../mappings.md — the shipped
# adapter is ./normalize-thread-states.sh — and export it EMPTY when there are
# no threads rather than skipping the gate.
#
# Conventions: exit 0 pass, 1 on an unresolved / trail-less / unknown thread, 2
# on a usage error; states file via arg or THREADS env so the self-test drives
# it with fixtures.
#
# Usage:
#   check-threads-resolved.sh pr-threads.txt
#   THREADS=pr-threads.txt check-threads-resolved.sh
set -u
THREADS="${1:-${THREADS:-}}"

[ -n "$THREADS" ] || { echo "ERROR: no states file given (arg or THREADS=)" >&2; exit 2; }
[ -f "$THREADS" ] || { echo "ERROR: states file not found: $THREADS" >&2; exit 2; }

# `addressed`, `deferred` and `moot` each claim that some change exists — the fix,
# the filed follow-up, the commit that superseded the finding — so the trail must
# actually point at one: a commit sha, a `#123` change/PR number, a tracker key
# (`ISSUE-482`, `PROJ-17`), or a URL. A bare word like `not-fixed` or `later` is
# not a reference and must not pass as one.
#
# A bare 7–40 hex run is NOT enough on its own, because English is full of them:
# `defaced`, `effaced`, `deadbeef` and `accede` are all valid hex, so `moot defaced`
# would sail through as if it named a commit — the frictionless dismissal this gate
# exists to refuse. A sha must therefore carry at least one DIGIT, which no English
# word does. The roughly 1-in-700 real sha that is all letters needs the explicit
# `commit <sha>` / `sha: <sha>` form instead, which is clearer in a trail anyway.
#
# Candidates are whole words, with surrounding quotes/brackets/punctuation stripped,
# so `(a1b2c3d)`, `` `a1b2c3d` `` and `a1b2c3d.` all count while a match buried
# inside a longer token does not.
has_ref() { # <trail> -> 0 if it carries a commit / change / tracker / URL reference
  local t="$1" w prev="" rc=1 noglob=0
  case $- in *f*) noglob=1 ;; esac
  set -f                                  # word-split $t without letting it glob
  for w in $t; do
    while [ -n "$w" ]; do case "$w" in [\`\'\"\(\[\{\<]*) w="${w#?}" ;; *) break ;; esac; done
    while [ -n "$w" ]; do case "$w" in *[\`\'\"\)\]\}\>.,\;:!?]) w="${w%?}" ;; *) break ;; esac; done
    if [[ "$w" =~ ^[0-9a-fA-F]{7,40}$ && "$w" =~ [0-9] ]]; then rc=0; break; fi
    if [[ "$w" =~ ^#[0-9]+$ ]]; then rc=0; break; fi
    if [[ "$w" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then rc=0; break; fi
    if [[ "$w" =~ ^https?://[^[:space:]]+$ ]]; then rc=0; break; fi
    # The explicit escape hatch for an all-letter sha: `commit <sha>` / `sha: <sha>`.
    # The sha has to be the WHOLE next word. Matching it as a substring would let
    # `commit defacedly` through — `defaced` matches and the trailing `l` looks like
    # a boundary — which is the same hex-is-English trap one level down.
    if [[ "$prev" =~ ^([Cc]ommit|[Ss]ha):?$ && "$w" =~ ^[0-9a-fA-F]{7,40}$ ]]; then rc=0; break; fi
    prev="$w"
  done
  [ "$noglob" -eq 1 ] || set +f
  return "$rc"
}

# What each terminal state must carry, and the words its failure message uses.
ref_needed() { # <state> -> what the reference should name, or empty if prose suffices
  case "$1" in
    addressed) echo "the commit/change that fixed it" ;;
    deferred)  echo "the follow-up issue/PR it was filed as" ;;
    moot)      echo "the commit/change that superseded it" ;;
    *)         echo "" ;;
  esac
}

bad=0
open=0 noreason=0 undeclared=0 unknown=0
while read -r id state reason || [ -n "$id" ]; do   # `||` handles a final line with no newline
  case "$id" in ''|'#'*) continue ;; esac   # skip blank / comment lines
  case "$state" in
    addressed|deferred|moot)
      wants=$(ref_needed "$state")
      if [ -z "${reason// /}" ]; then
        echo "FAIL $id — '$state' with no audit trail (name $wants)"
        noreason=$((noreason+1)); bad=1
      elif ! has_ref "$reason"; then
        echo "FAIL $id — '$state' trail '$reason' names no commit/change/tracker/URL reference ($wants)"
        noreason=$((noreason+1)); bad=1
      fi ;;
    rejected)
      if [ -z "${reason// /}" ]; then
        echo "FAIL $id — 'rejected' with no reason (needs an audit trail)"
        noreason=$((noreason+1)); bad=1
      fi ;;
    unclassified)
      echo "FAIL $id — resolved, but the reply declares no verdict (see ../../mappings.md § Encoding the declared verdict)"
      undeclared=$((undeclared+1)); bad=1 ;;
    open|'')
      echo "FAIL $id — thread still open (resolve it before merge)"
      open=$((open+1)); bad=1 ;;
    *)
      echo "FAIL $id — unknown state '$state' (want: addressed|rejected|deferred|moot)"
      unknown=$((unknown+1)); bad=1 ;;
  esac
done < "$THREADS"

if [ "$bad" -ne 0 ]; then
  echo ""
  echo "Unresolved-threads gate FAILED: $open open, $noreason trail-less, $undeclared undeclared, $unknown unknown."
  exit 1
fi
echo "OK — every review thread is terminal with a trail"
