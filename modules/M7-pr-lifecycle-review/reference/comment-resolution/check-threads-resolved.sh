#!/usr/bin/env bash
# Unresolved-threads merge gate: no PR merges with an open review thread, and
# every non-fix resolution carries an audit trail.
#
# This is the comment-resolution loop (address / reject / defer — see
# ../../templates/PR-LIFECYCLE.md) made mechanical. A forge's own branch
# protection can require "all threads resolved", but that is a bare boolean; it
# cannot tell an addressed thread from one a bot marked resolved with no
# reason. This gate reads a small, forge-exported states file so it can enforce
# the *trail*, not just the flag.
#
# Input: a states file, one thread per line, whitespace-separated:
#     <thread-id> <state> [reason / follow-up reference ...]
# States and their rule:
#     addressed   fixed in the PR                      -> pass ONLY with a fix reference
#     rejected    won't fix                            -> pass ONLY with a reason
#     deferred    filed as a follow-up                 -> pass ONLY with a reference
#     open        not yet terminal                     -> FAIL (blocks merge)
#     <other>     typo / unknown                       -> FAIL
# Blank lines and `# comments` are ignored. An empty file means zero threads
# (pass). Produce the file from your forge per ../mappings.md; export it EMPTY
# when there are no threads rather than skipping the gate.
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

# An `addressed` thread claims a fix, so its trail must actually point at one: a
# commit sha, a `#123` change/PR number, or a URL. A bare word like `not-fixed`
# is not a fix reference — it must not pass as one.
has_fix_ref() { # <trail> -> 0 if it carries a commit/change/URL reference
  local t="$1"
  [[ "$t" =~ (^|[^0-9a-fA-F])[0-9a-fA-F]{7,40}([^0-9a-fA-F]|$) ]] && return 0
  [[ "$t" =~ (^|[[:space:]])#[0-9]+ ]] && return 0
  [[ "$t" =~ https?:// ]] && return 0
  return 1
}

bad=0
open=0 noreason=0 unknown=0
while read -r id state reason || [ -n "$id" ]; do   # `||` handles a final line with no newline
  case "$id" in ''|'#'*) continue ;; esac   # skip blank / comment lines
  case "$state" in
    addressed)
      if [ -z "${reason// /}" ]; then
        echo "FAIL $id — 'addressed' with no fix reference (link the commit/change)"
        noreason=$((noreason+1)); bad=1
      elif ! has_fix_ref "$reason"; then
        echo "FAIL $id — 'addressed' trail '$reason' names no commit/change/PR reference"
        noreason=$((noreason+1)); bad=1
      fi ;;
    rejected|deferred)
      if [ -z "${reason// /}" ]; then
        echo "FAIL $id — '$state' with no reason/reference (needs an audit trail)"
        noreason=$((noreason+1)); bad=1
      fi ;;
    open|'')
      echo "FAIL $id — thread still open (resolve it before merge)"
      open=$((open+1)); bad=1 ;;
    *)
      echo "FAIL $id — unknown state '$state' (want: addressed|rejected|deferred)"
      unknown=$((unknown+1)); bad=1 ;;
  esac
done < "$THREADS"

if [ "$bad" -ne 0 ]; then
  echo ""
  echo "Unresolved-threads gate FAILED: $open open, $noreason trail-less, $unknown unknown."
  exit 1
fi
echo "OK — every review thread is terminal with a trail"
