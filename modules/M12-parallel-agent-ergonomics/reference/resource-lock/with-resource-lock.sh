#!/usr/bin/env bash
# Cross-worktree mutex: run a heavy command under a machine-wide lock.
#
# Several agents on one machine each kicking off a full build-and-test run at
# once thrash the CPU, the disk, and shared caches — every run gets slower and
# some fall over. This wrapper serializes such runs: only one holder of a named
# lock runs its command at a time; the others WAIT (up to a timeout) and then
# proceed. It coordinates ACROSS worktrees because the lock lives at a
# machine-global path (TMPDIR), not inside any one worktree.
#
# The lock is a SYMLINK whose target is the holder's PID. Creating a symlink is
# ATOMIC on POSIX and fails if the name already exists, so exactly one racer
# wins — and because the target IS the PID, ownership and owner-identity are
# established in the SAME atomic step. There is no "won the lock but has not
# recorded its owner yet" window (the flaw of mkdir-a-dir-then-write-a-pidfile:
# a holder paused between the two leaves an ownerless lock another process could
# steal, breaking mutual exclusion). A lock left by a CRASHED holder is reclaimed
# once its PID is gone from the process table; a live holder is never torn out.
#
# CI bypass: on a CI runner each job already gets its own isolated machine, so
# there is nothing to serialize and the wait is pure latency. If CI=1 (or
# CI=true) or RESOURCE_LOCK_BYPASS=1, the command runs immediately, unlocked.
#
# Config via env (or --lock for the name):
#     LOCK_NAME     the lock to contend on (default "heavy"); --lock NAME wins
#     LOCK_TIMEOUT  seconds to wait for the lock before giving up (default 60)
#     LOCK_POLL     poll interval while waiting, seconds (default 0.2)
#     LOCK_ROOT     directory the lock lives under (default ${TMPDIR:-/tmp})
#
# Exit codes: the command's own exit code on success; 2 on a usage error;
#             3 if the lock could not be acquired within LOCK_TIMEOUT.
#
# Usage:
#   with-resource-lock.sh pnpm test            # LOCK_NAME defaults to "heavy"
#   LOCK_NAME=build with-resource-lock.sh make build
#   with-resource-lock.sh --lock e2e -- ./run-e2e.sh   # -- ends option parsing
set -u

LOCK_NAME="${LOCK_NAME:-heavy}"
LOCK_TIMEOUT="${LOCK_TIMEOUT:-60}"
LOCK_POLL="${LOCK_POLL:-0.2}"
LOCK_ROOT="${LOCK_ROOT:-${TMPDIR:-/tmp}}"

# Optional --lock NAME before the command; -- ends option parsing.
while [ "$#" -gt 0 ]; do
  case "$1" in
    -l|--lock) [ "${2:-}" ] || { echo "ERROR: --lock needs a name" >&2; exit 2; }
               LOCK_NAME="$2"; shift 2 ;;
    --)        shift; break ;;
    -*)        echo "ERROR: unknown option: $1" >&2; exit 2 ;;
    *)         break ;;
  esac
done

[ "$#" -ge 1 ] || { echo "ERROR: no command given to run under the lock" >&2; exit 2; }
case "$LOCK_TIMEOUT" in ''|*[!0-9]*) echo "ERROR: LOCK_TIMEOUT must be a non-negative integer (seconds): $LOCK_TIMEOUT" >&2; exit 2 ;; esac
# LOCK_POLL is exposed config and drives `sleep` in the wait loop: reject a
# non-numeric value (would spew sleep errors) or a non-positive one (0 spins the
# CPU until timeout, misreported as contention) up front, before any waiting.
case "$LOCK_POLL" in *[!0-9.]*|''|.|*.*.*) echo "ERROR: LOCK_POLL must be a positive number (seconds): $LOCK_POLL" >&2; exit 2 ;; esac
# All digits zero (0, 0.0, .00, ...) -> not positive. Strip dots+zeros; if
# nothing is left, there is no non-zero digit.
[ -n "$(printf '%s' "$LOCK_POLL" | tr -d '.0')" ] || { echo "ERROR: LOCK_POLL must be greater than zero: $LOCK_POLL" >&2; exit 2; }

# CI bypass — nothing to serialize on an already-isolated runner. exec so the
# command's exit code becomes ours with no wrapper in between.
if [ "${CI:-}" = "1" ] || [ "${CI:-}" = "true" ] || [ "${RESOURCE_LOCK_BYPASS:-}" = "1" ]; then
  exec "$@"
fi

# Build the lock path. Sanitize the name so it can't escape LOCK_ROOT.
safe=$(printf '%s' "$LOCK_NAME" | tr -c 'A-Za-z0-9._-' '_')
lock="$LOCK_ROOT/groundwork-lock.$safe"          # a symlink; its target is the PID
mkdir -p "$LOCK_ROOT" 2>/dev/null || true
# A LOCK_ROOT that is not a writable directory (a regular file, a bad path) is a
# SETUP error, not contention: every ln -s would fail and the loop would burn
# LOCK_TIMEOUT before exit 3, misdirecting the operator. Fail fast (exit 2).
[ -d "$LOCK_ROOT" ] && [ -w "$LOCK_ROOT" ] || { echo "ERROR: LOCK_ROOT is not a writable directory: $LOCK_ROOT" >&2; exit 2; }

# Reclaim the lock iff it is provably reclaimable — its holder PID is gone, or it
# is a stale non-symlink left by some other tool. Guarded by an atomic mkdir so
# at most one racer reclaims, and it re-reads the holder UNDER that guard, so it
# never tears down a lock a live holder still owns.
reclaim_locked() {
  local holder reclaimdir="$lock.reclaiming"
  mkdir "$reclaimdir" 2>/dev/null || return 0    # another reclaimer is on it
  if [ -L "$lock" ]; then
    holder=$(readlink "$lock" 2>/dev/null) || holder=""
    if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then
      rm -f "$lock" 2>/dev/null || true          # dead holder — remove it
    fi
  elif [ -e "$lock" ]; then
    rm -rf "$lock" 2>/dev/null || true           # a non-symlink leftover
  fi
  rmdir "$reclaimdir" 2>/dev/null || true
}

acquire() {
  local start now holder
  start=$(date +%s)
  while :; do
    # Clear a stale non-symlink leftover (an old-format lock dir, a foreign
    # tool's file) BEFORE the ln -s: `ln -s pid dir` would create the link
    # INSIDE the directory and wrongly report success.
    if [ -e "$lock" ] && [ ! -L "$lock" ]; then reclaim_locked; fi
    # Atomic: win the lock AND record the owner (this PID) in one step.
    if ln -s "$$" "$lock" 2>/dev/null; then
      # Verify a true acquisition: if the leftover was not cleared in time, the
      # ln may have landed inside a directory ($lock/<pid>) and still exited 0.
      if [ -L "$lock" ] && [ "$(readlink "$lock" 2>/dev/null)" = "$$" ]; then return 0; fi
      rm -f "$lock/$$" 2>/dev/null || true       # undo a stray inner link
    fi
    now=$(date +%s)
    if [ -L "$lock" ]; then
      holder=$(readlink "$lock" 2>/dev/null) || holder=""
      # A dead holder is reclaimable at once — there is no unrecorded-owner
      # window, so an existing symlink always names a real (once-live) holder.
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then reclaim_locked; fi
    fi
    [ $((now - start)) -ge "$LOCK_TIMEOUT" ] && return 1
    sleep "$LOCK_POLL"
  done
}

release() {
  # Only tear down a lock we still own (a reclaim may have handed it on).
  local holder
  holder=$(readlink "$lock" 2>/dev/null) || holder=""
  if [ "$holder" = "$$" ]; then rm -f "$lock" 2>/dev/null || true; fi
}

if acquire; then
  trap release EXIT INT TERM
  "$@"                                            # no `set -e`: capture rc even on failure
  exit $?
fi

echo "ERROR: could not acquire lock '$LOCK_NAME' within ${LOCK_TIMEOUT}s (held by another worktree?)" >&2
exit 3
