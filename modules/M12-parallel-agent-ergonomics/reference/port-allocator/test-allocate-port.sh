#!/usr/bin/env bash
# Self-test for allocate-port.sh. Asserts:
#   * determinism      — the same id yields the same port on repeat calls, and
#                        matches the checked-in golden values (stable hashing);
#   * range membership — several ids all land in [PORT_BASE, PORT_BASE+PORT_SPAN);
#   * distinctness     — a few different ids get different ports (no constant);
#   * usage errors     — a missing id and a bad range each exit 2.
# Prints PASS:/FAIL: lines and exits non-zero if any case fails.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
alloc="$here/allocate-port.sh"
golden="$here/fixtures/golden-ports.tsv"
rc=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; rc=1; }

# --- determinism: two calls agree, and agree with the golden fixture ----------
while read -r id want; do
  case "$id" in ''|\#*) continue ;; esac
  got1=$("$alloc" "$id"); got2=$("$alloc" "$id")
  if [ "$got1" = "$got2" ] && [ "$got1" = "$want" ]; then
    pass "determinism: $id -> $got1 (stable, matches golden)"
  else
    fail "determinism: $id -> '$got1'/'$got2' want '$want'"
  fi
done < "$golden"

# WORKTREE_ID env and the positional arg are the same input path.
if [ "$(WORKTREE_ID=main "$alloc")" = "$("$alloc" main)" ]; then
  pass "arg and WORKTREE_ID agree"
else
  fail "arg and WORKTREE_ID disagree"
fi

# --- range membership: every id lands inside [BASE, BASE+SPAN) ----------------
base=30000; span=200
inrange_ok=1
for id in main develop feature-a feature-b bugfix-c release-9 spike/xyz agent_7; do
  p=$(PORT_BASE=$base PORT_SPAN=$span "$alloc" "$id")
  if [ "$p" -lt "$base" ] || [ "$p" -ge $((base + span)) ]; then
    inrange_ok=0; echo "  out of range: $id -> $p (want [$base,$((base+span))))"
  fi
done
[ "$inrange_ok" -eq 1 ] && pass "range membership: 8 ids all within [$base,$((base+span)))" \
                        || fail "range membership: an id fell outside the range"

# --- distinctness: four different ids give four different ports ----------------
ports=$(for id in main feature-login feature-logout bugfix-auth; do "$alloc" "$id"; done)
uniq_n=$(printf '%s\n' "$ports" | sort -u | wc -l | tr -d ' ')
if [ "$uniq_n" -eq 4 ]; then
  pass "distinctness: 4 ids -> 4 distinct ports"
else
  fail "distinctness: expected 4 distinct ports, got $uniq_n"
fi

# --- usage errors -------------------------------------------------------------
run_err() { # <expected-exit> <label>; command in remaining args
  local want="$1" label="$2"; shift 2
  "$@" >/dev/null 2>&1; local got=$?
  [ "$got" -eq "$want" ] && pass "$label (exit $got)" || { fail "$label (want $want, got $got)"; }
}
run_err 2 "missing id errors"           "$alloc"
run_err 2 "empty WORKTREE_ID errors"    env WORKTREE_ID= "$alloc"
run_err 2 "zero span errors"            env PORT_SPAN=0   "$alloc" x
run_err 2 "non-numeric span errors"     env PORT_SPAN=abc "$alloc" x
run_err 2 "non-numeric base errors"     env PORT_BASE=xx  "$alloc" x
run_err 2 "range past 65535 errors"     env PORT_BASE=65500 PORT_SPAN=1000 "$alloc" x

[ "$rc" -eq 0 ] && echo "All port-allocator self-tests passed." || echo "port-allocator self-tests FAILED."
exit "$rc"
