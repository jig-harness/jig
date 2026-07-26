#!/usr/bin/env bash
# Self-test for normalize-thread-states.sh. The point of this exporter is that
# the gate can actually read what it emits, so every case asserts BOTH halves:
# the states file matches a checked-in golden file, AND the gate's exit code on
# that file is what the case intends. Checking the mapping without running the
# gate on the result is how a documented encoding ends up unreadable.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
norm="$here/normalize-thread-states.sh"
gate="$here/check-threads-resolved.sh"
fix="$here/fixtures/raw"
rc=0
tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT

chain() { # <encoding> <fixture-name> <expected-gate-exit>
  local enc="$1" name="$2" want_gate="$3" out="$tmp/$2.txt" got
  VERDICT_ENCODING="$enc" "$norm" "$fix/$name.tsv" > "$out" 2>/dev/null
  got=$?
  if [ "$got" -ne 0 ]; then
    echo "FAIL: $name exports cleanly (normalizer exit $got)"; rc=1; return
  fi
  if diff -u "$fix/$name.expected" "$out" > "$tmp/$name.diff"; then
    echo "PASS: $name maps to the expected gate input"
  else
    echo "FAIL: $name maps to the expected gate input"; sed 's/^/      /' "$tmp/$name.diff"; rc=1
  fi
  "$gate" "$out" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want_gate" ]; then echo "PASS: $name gate verdict (exit $got)"
  else echo "FAIL: $name gate verdict (want $want_gate, got $got)"; rc=1; fi
}

# Each documented encoding reaches the gate as the state it means.
chain token   token       0
chain trailer trailer     0
# A reply that declares nothing must not be guessed at — `unclassified` fails.
chain token   undeclared  1
# An unresolved thread exports as `open` whatever its last reply says.
chain token   open        1
# Several replies per thread, newest first: the freshest DECLARED verdict wins, so
# a reviewer's "confirmed, thanks" cannot bury the author's verdict beneath it.
chain token   verdict-then-ack 1

expect_exit() { # <expected-exit> <label> <encoding> <rows-file>
  VERDICT_ENCODING="$3" "$norm" "$4" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

expect_exit 2 "non-boolean resolved column errors" token    "$fix/bad-resolved.tsv"
expect_exit 2 "missing rows file errors"           token    "$fix/does-not-exist.tsv"
expect_exit 2 "unknown encoding errors"            sniffing "$fix/token.tsv"

# The anchor is the whole safety property: a state word anywhere other than the
# encoding's position is narration, and must not be read as a verdict.
expect_state() { # <label> <encoding> <reply-body> <expected-state>
  local got
  printf 'T-1\ttrue\t%s\n' "$3" > "$tmp/one.tsv"
  got=$(VERDICT_ENCODING="$2" "$norm" "$tmp/one.tsv" | awk '{print $2}')
  if [ "$got" = "$4" ]; then echo "PASS: $1"
  else echo "FAIL: $1 (got '$got', want '$4')"; rc=1; fi
}

expect_state "mid-body state word is not a verdict"     token   "This is intended — rejected upstream years ago"  unclassified
expect_state "trailer encoding ignores a leading token" trailer "**accepted** — added the guard in a1b2c3d"       unclassified
expect_state "token encoding ignores a trailing trailer" token  "added the guard in a1b2c3d. Verdict: accepted"   unclassified
# Emphasis and trailing punctuation are cosmetic; the synonym table is not.
expect_state "bold token is read through the markers"   token   "**accepted** — added the guard in a1b2c3d"       addressed
expect_state "a synonym maps onto the closed set"       token   "obsolete: the helper went away in 4f5a6b7"       moot

# Multi-reply scanning must not weaken the two properties it could plausibly break.
multi() { # <label> <expected-state> <rows...>
  local label="$1" want="$2"; shift 2
  printf '%s\n' "$@" > "$tmp/multi.tsv"
  local got; got=$("$norm" "$tmp/multi.tsv" | awk '{print $2}')
  if [ "$got" = "$want" ]; then echo "PASS: $label"
  else echo "FAIL: $label (got '$got', want '$want')"; rc=1; fi
}
multi "the newest declared verdict wins over an older one" addressed \
  "$(printf 'T-1\ttrue\t**accepted** — fixed in a1b2c3d')" \
  "$(printf 'T-1\ttrue\t**rejected** — actually intended')"
multi "an unresolved thread stays open despite a verdict-shaped reply" open \
  "$(printf 'T-1\tfalse\t**accepted** — fixed in a1b2c3d')"
multi "acknowledgements alone stay unclassified" unclassified \
  "$(printf 'T-1\ttrue\tsounds good')" \
  "$(printf 'T-1\ttrue\tthanks for looking')"

[ "$rc" -eq 0 ] && echo "All verdict-exporter self-tests passed." || echo "verdict-exporter self-tests FAILED."
exit "$rc"
