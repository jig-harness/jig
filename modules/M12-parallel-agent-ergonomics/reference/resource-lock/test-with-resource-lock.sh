#!/usr/bin/env bash
# Self-test for with-resource-lock.sh. Asserts:
#   * mutual exclusion — two concurrent invocations of the SAME lock never run
#     their critical sections at the same time (marker-overlap check);
#   * CI bypass        — with CI=1 the command runs immediately even while the
#     lock is held by someone else;
#   * stale reclaim    — a lock symlink whose target PID is dead is reclaimed,
#     not waited on; a non-symlink leftover (old-format lock) is reclaimed too;
#   * exit codes       — the command's code propagates; a usage error is 2; a
#     lock-acquire timeout is 3.
# Prints PASS:/FAIL: lines and exits non-zero if any case fails.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock="$here/with-resource-lock.sh"
rc=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; rc=1; }

# This test IS run in CI, where CI is set — which would bypass every lock and
# invalidate the locking assertions. Scrub both bypass signals; the CI-bypass
# case re-enables CI locally for just that run.
unset CI RESOURCE_LOCK_BYPASS

# Isolated, machine-global lock root + a scratch dir, so the test never touches
# a real lock and cleans up after itself.
work=$(mktemp -d 2>/dev/null || mktemp -d -t m12lock)
export LOCK_ROOT="$work/locks"
export SHARED="$work/shared"
mkdir -p "$LOCK_ROOT" "$SHARED"
trap 'rm -rf "$work"' EXIT

lock_for() { # <name> -> the symlink path the wrapper computes for that lock
  local safe; safe=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s/groundwork-lock.%s' "$LOCK_ROOT" "$safe"
}
# Start a live holder in THIS shell (not a subshell), so its PID is real and
# stays alive; sets HOLD_PID. Backgrounding inside $(...) would tie the holder
# to the command-substitution pipe, so we set a global instead of echoing. The
# lock is a symlink whose target is that PID (what the wrapper creates).
hold() { # <name>
  sleep 30 >/dev/null 2>&1 &
  HOLD_PID=$!
  ln -s "$HOLD_PID" "$(lock_for "$1")"
}
free_hold() { # <name> <pid>
  kill "$2" 2>/dev/null; wait "$2" 2>/dev/null
  rm -f "$(lock_for "$1")"
}

# --- mutual exclusion ---------------------------------------------------------
# Each held section appends "ENTER <id>", holds briefly, then "EXIT <id>" to a
# shared log (>> is atomic for these tiny writes). If the mutex serializes the
# two runs the log reads ENTER/EXIT/ENTER/EXIT — never two inside at once. This
# detects interleaving even when both invocations start at the same instant
# (a plain "is a marker present?" check at entry would miss that, since both
# check before either writes). check_serialized() flags any ENTER seen while
# another id is still inside.
check_serialized() { # <log> -> 0 if strictly serialized, 1 if overlapping
  awk '/^ENTER/ { if (inside>0) bad=1; inside++ }
       /^EXIT/  { inside-- }
       END { exit (bad?1:0) }' "$1"
}
: > "$SHARED/log"
crit='echo "ENTER $0" >> "$SHARED/log"; sleep 0.3; echo "EXIT $0" >> "$SHARED/log"'
LOCK_NAME=mx "$lock" sh -c "$crit" A &
LOCK_NAME=mx "$lock" sh -c "$crit" B &
wait
enters=$(grep -c '^ENTER' "$SHARED/log" || true)
if [ "$enters" -eq 2 ] && check_serialized "$SHARED/log"; then
  pass "mutual exclusion: two concurrent runs serialized (no interleaving)"
else
  fail "mutual exclusion: enters=$enters, log interleaved (see $SHARED/log)"
fi
# Sensitivity guard: the SAME sections with locking bypassed MUST interleave —
# proves the check above is real, not vacuously passing.
: > "$SHARED/log"
RESOURCE_LOCK_BYPASS=1 LOCK_NAME=mx "$lock" sh -c "$crit" A &
RESOURCE_LOCK_BYPASS=1 LOCK_NAME=mx "$lock" sh -c "$crit" B &
wait
if check_serialized "$SHARED/log"; then
  fail "sensitivity: unlocked runs did NOT interleave — the mutex test is vacuous"
else
  pass "sensitivity: unlocked runs interleave (the mutual-exclusion check is real)"
fi

# --- CI bypass: runs immediately even while the lock is held ------------------
hold busy
out=$(CI=1 LOCK_NAME=busy LOCK_TIMEOUT=1 "$lock" sh -c 'echo ran'); got=$?
if [ "$got" -eq 0 ] && [ "$out" = "ran" ]; then
  pass "CI bypass: ran immediately under a held lock (exit 0)"
else
  fail "CI bypass: exit $got out='$out' (want 0 / 'ran')"
fi
# and the RESOURCE_LOCK_BYPASS signal does the same
out=$(RESOURCE_LOCK_BYPASS=1 LOCK_NAME=busy LOCK_TIMEOUT=1 "$lock" sh -c 'echo ran2'); got=$?
[ "$got" -eq 0 ] && [ "$out" = "ran2" ] && pass "RESOURCE_LOCK_BYPASS bypass runs immediately" \
                                        || fail "RESOURCE_LOCK_BYPASS bypass: exit $got out='$out'"
free_hold busy "$HOLD_PID"

# --- timeout: a live holder blocks acquisition -> exit 3 ----------------------
hold busy2
LOCK_NAME=busy2 LOCK_TIMEOUT=1 "$lock" true >/dev/null 2>&1; got=$?
[ "$got" -eq 3 ] && pass "lock-acquire timeout exits 3" || fail "timeout: want 3, got $got"
free_hold busy2 "$HOLD_PID"

# --- stale reclaim: a dead holder's lock is reclaimed, not waited on ----------
# Stage a lock symlink whose target is a PID that has ALREADY EXITED on its own
# (a just-finished subshell — not a backgrounded child we kill, so nothing
# interacts with this shell's traps). CHECK the setup and ASSERT the stale lock
# is in place before invoking the wrapper, so a silently-failed setup or a reused
# PID fails loudly instead of letting the wrapper take a fresh lock and pass
# vacuously. With reclaim disabled the wrapper times out (exit 3), so a passing
# exit 0 provably means reclaim ran.
dead=$(sh -c 'echo "$$"')                       # a subshell PID, dead by now
sl=$(lock_for stale)
if kill -0 "$dead" 2>/dev/null; then
  fail "stale reclaim: PID $dead was reused and is live — rerun the test"
elif ! ln -s "$dead" "$sl" 2>/dev/null; then
  fail "stale reclaim: could not stage the stale lock at $sl (setup failed)"
elif [ ! -L "$sl" ] || [ "$(readlink "$sl" 2>/dev/null)" != "$dead" ]; then
  fail "stale reclaim: stale lock precondition not met — test would be vacuous"
else
  out=$(LOCK_NAME=stale LOCK_TIMEOUT=5 "$lock" sh -c 'echo reclaimed'); got=$?
  if [ "$got" -eq 0 ] && [ "$out" = "reclaimed" ]; then
    pass "stale lock (dead PID) reclaimed and command ran (exit 0)"
  else
    fail "stale reclaim: exit $got out='$out' (want 0 / 'reclaimed')"
  fi
fi

# --- non-symlink leftover: an old-format lock dir is reclaimed, not waited on --
# The symlink protocol has no ownerless (unrecorded-owner) state — owner identity
# is atomic with acquisition — but a directory left by a different/older tool
# must not wedge the lock forever.
nsl=$(lock_for nonsym)
if ! mkdir "$nsl" 2>/dev/null; then
  fail "non-symlink reclaim: could not stage a leftover dir at $nsl"
else
  out=$(LOCK_NAME=nonsym LOCK_TIMEOUT=5 "$lock" sh -c 'echo owned'); got=$?
  if [ "$got" -eq 0 ] && [ "$out" = "owned" ]; then
    pass "non-symlink leftover reclaimed and command ran (exit 0)"
  else
    fail "non-symlink reclaim: exit $got out='$out' (want 0 / 'owned')"
  fi
fi

# --- exit-code propagation + usage errors -------------------------------------
LOCK_NAME=ec "$lock" sh -c 'exit 7' >/dev/null 2>&1; got=$?
[ "$got" -eq 7 ] && pass "command exit code propagates (7)" || fail "propagation: want 7, got $got"
LOCK_NAME=ec "$lock" true >/dev/null 2>&1; got=$?
[ "$got" -eq 0 ] && pass "successful command propagates 0" || fail "propagation: want 0, got $got"

"$lock" >/dev/null 2>&1; got=$?
[ "$got" -eq 2 ] && pass "no command errors (exit 2)" || fail "no command: want 2, got $got"
"$lock" --lock >/dev/null 2>&1; got=$?
[ "$got" -eq 2 ] && pass "--lock without a name errors (exit 2)" || fail "--lock bare: want 2, got $got"
LOCK_TIMEOUT=abc "$lock" true >/dev/null 2>&1; got=$?
[ "$got" -eq 2 ] && pass "non-numeric LOCK_TIMEOUT errors (exit 2)" || fail "bad timeout: want 2, got $got"
LOCK_POLL=bogus "$lock" true >/dev/null 2>&1; got=$?
[ "$got" -eq 2 ] && pass "non-numeric LOCK_POLL errors (exit 2)" || fail "bad poll: want 2, got $got"
LOCK_POLL=0 "$lock" true >/dev/null 2>&1; got=$?
[ "$got" -eq 2 ] && pass "zero LOCK_POLL errors (exit 2)" || fail "zero poll: want 2, got $got"
# A LOCK_ROOT that is not a writable directory is a setup error (exit 2), fast —
# not lock contention (exit 3 after the whole timeout).
badroot=$(mktemp)
LOCK_ROOT="$badroot" LOCK_TIMEOUT=30 "$lock" true >/dev/null 2>&1; got=$?
[ "$got" -eq 2 ] && pass "non-dir LOCK_ROOT errors fast (exit 2)" || fail "bad root: want 2, got $got"
rm -f "$badroot"

[ "$rc" -eq 0 ] && echo "All resource-lock self-tests passed." || echo "resource-lock self-tests FAILED."
exit "$rc"
