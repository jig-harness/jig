#!/usr/bin/env bash
# Verified-pointer freshness watchdog — the self-healing check made mechanical.
#
# The problem it catches. Post-merge verification advances an explicit
# `verified` pointer (a branch or tag) to the newest commit that passed the
# full verification suite; deploys only ever ship what `verified` points at.
# That is only trustworthy if verification KEEPS UP: if the verifier wedges
# (a flaky suite, a broken runner, a stuck queue), `verified` silently freezes
# while the default branch races ahead, and "we deploy verified artifacts" now
# means "we deploy last week's code" — with nobody paged. This watchdog turns
# "is verification keeping up?" into a check that fails loudly, so an operator
# (or an automated heal run) is triggered instead of the freeze going unnoticed.
#
# What it measures. Two independent freshness signals for the pointer:
#   * BEHIND        — how many commits the verified pointer trails the
#                     default-branch tip (its commit distance).
#   * AGE_SECONDS   — how long since the verified pointer last advanced.
# You may supply either or both. The pointer is STALLED (fail) if EITHER signal
# exceeds its threshold; it is FRESH (pass) only if every supplied signal is at
# or under its threshold. At-threshold is fresh; only strictly-greater stalls.
#
# Thresholds (env, with defaults; validated up front like check-parity.sh does
# for MIN_PRECISION, because a bad threshold silently corrupts every verdict):
#   MAX_BEHIND        default 20     (commits)
#   MAX_AGE_SECONDS   default 86400  (24h)
#
# Input. Observations arrive via env (BEHIND=, AGE_SECONDS=) or via an input
# file passed as $1 whose lines are `<KEY> <value>` pairs (BEHIND / AGE_SECONDS,
# each at most once; blank lines and `# comments` ignored). Compute them from
# git, e.g.
#   BEHIND=$(git rev-list --count verified..origin/main)
#   AGE_SECONDS=$(( $(date +%s) - $(git log -1 --format=%ct verified) ))
# (recipes per forge in ../../mappings.md).
#
# Portable: bash + coreutils. Conventions: exit 0 fresh, 1 stalled (page/heal),
# 2 on a usage / non-numeric / bad-threshold error.
#
# Usage:
#   BEHIND=3 AGE_SECONDS=3600 check-verified-fresh.sh
#   check-verified-fresh.sh observation.txt
#   MAX_BEHIND=10 MAX_AGE_SECONDS=43200 check-verified-fresh.sh obs.txt
set -u

INPUT="${1:-}"
BEHIND="${BEHIND:-}"
AGE_SECONDS="${AGE_SECONDS:-}"
MAX_BEHIND="${MAX_BEHIND:-20}"
MAX_AGE_SECONDS="${MAX_AGE_SECONDS:-86400}"

# A non-negative integer that bash arithmetic (`-gt`) can compare safely. Cap
# the length: past ~19 digits a value exceeds the signed-64-bit range and `-gt`
# silently misbehaves, which could let a huge (malformed) BEHIND/AGE_SECONDS
# slip past the stall check as "fresh". 18 digits is comfortably in range.
is_uint() { [[ "$1" =~ ^[0-9]+$ ]] && [ "${#1}" -le 18 ]; }

# An input file supplies the observations as `<KEY> <value>` lines. An unknown
# key or a malformed line is schema drift, not a passing input — fail closed (2).
# A DUPLICATE key is fail-closed too: if a producer accidentally concatenates or
# repeats records, silently letting the last line win could mask a stalled
# observation (`BEHIND 99` then `BEHIND 0` would report fresh) — the exact
# failure this watchdog exists to catch. Each key may appear at most once.
if [ -n "$INPUT" ]; then
  [ -f "$INPUT" ] || { echo "ERROR: input file not found: $INPUT" >&2; exit 2; }
  behind_seen=0; age_seen=0
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%%#*}"                                   # drop a comment
    read -r key val extra <<< "$line"
    [ -n "$key" ] || continue                           # blank / comment-only line
    if [ -z "$val" ] || [ -n "$extra" ]; then
      echo "ERROR: bad line in $INPUT (want '<KEY> <value>'): $raw" >&2; exit 2
    fi
    case "$key" in
      BEHIND)      [ "$behind_seen" -eq 0 ] || { echo "ERROR: duplicate BEHIND observation in $INPUT" >&2; exit 2; }
                   BEHIND="$val"; behind_seen=1 ;;
      AGE_SECONDS) [ "$age_seen" -eq 0 ] || { echo "ERROR: duplicate AGE_SECONDS observation in $INPUT" >&2; exit 2; }
                   AGE_SECONDS="$val"; age_seen=1 ;;
      *) echo "ERROR: unknown key in $INPUT (allowed: BEHIND, AGE_SECONDS): $key" >&2; exit 2 ;;
    esac
  done < "$INPUT"
fi

# Validate thresholds before scoring anything.
is_uint "$MAX_BEHIND"      || { echo "ERROR: MAX_BEHIND must be a non-negative integer: $MAX_BEHIND" >&2; exit 2; }
is_uint "$MAX_AGE_SECONDS" || { echo "ERROR: MAX_AGE_SECONDS must be a non-negative integer: $MAX_AGE_SECONDS" >&2; exit 2; }

# At least one observation is required — freshness cannot be asserted from no data.
if [ -z "$BEHIND" ] && [ -z "$AGE_SECONDS" ]; then
  echo "ERROR: no observation given — set BEHIND and/or AGE_SECONDS (env), or pass an input file" >&2
  exit 2
fi
if [ -n "$BEHIND" ];      then is_uint "$BEHIND"      || { echo "ERROR: BEHIND must be a non-negative integer: $BEHIND" >&2; exit 2; }; fi
if [ -n "$AGE_SECONDS" ]; then is_uint "$AGE_SECONDS" || { echo "ERROR: AGE_SECONDS must be a non-negative integer: $AGE_SECONDS" >&2; exit 2; }; fi

stalled=0
reasons=()
if [ -n "$BEHIND" ] && [ "$BEHIND" -gt "$MAX_BEHIND" ]; then
  stalled=1; reasons+=("verified pointer is $BEHIND commits behind the default-branch tip (max $MAX_BEHIND)")
fi
if [ -n "$AGE_SECONDS" ] && [ "$AGE_SECONDS" -gt "$MAX_AGE_SECONDS" ]; then
  stalled=1; reasons+=("verified pointer last advanced ${AGE_SECONDS}s ago (max ${MAX_AGE_SECONDS}s)")
fi

if [ "$stalled" -ne 0 ]; then
  echo "STALLED — verification has fallen behind; page on-call / trigger a heal run."
  for r in "${reasons[@]}"; do echo "  - $r"; done
  exit 1
fi

echo "OK — verified pointer is fresh (behind=${BEHIND:-n/a}/${MAX_BEHIND}, age=${AGE_SECONDS:-n/a}/${MAX_AGE_SECONDS}s)"
exit 0
