#!/usr/bin/env bash
# Deterministic per-worktree port allocator.
#
# Several agents on one machine, each in its own worktree, each starting a dev
# server or test listener, will fight over the same hardcoded port. The fix is
# to derive each worktree's port from a stable identifier (its branch or
# directory name), so the SAME worktree always gets the SAME port and two
# DIFFERENT worktrees almost never collide — no central registry, no lock.
#
# Input: a worktree identifier as arg $1 or env WORKTREE_ID (e.g. a branch or
# directory name). Config via env:
#     PORT_BASE   first port in the range (default 20000)
#     PORT_SPAN   how many ports the range holds (default 1000)
# The chosen port is always in [PORT_BASE, PORT_BASE + PORT_SPAN).
#
# Mechanism: a portable checksum (cksum, POSIX coreutils — same CRC on macOS
# and Linux) of the identifier, reduced modulo PORT_SPAN and offset by
# PORT_BASE. No external dependencies, no network probe. Because it hashes,
# two ids CAN collide (see README) — keep PORT_SPAN well above the number of
# worktrees you run at once.
#
# Exit codes: 0 prints the port on stdout; 2 on a missing id or a bad range.
#
# Usage:
#   allocate-port.sh feature-login            # -> a stable port for that id
#   WORKTREE_ID=feature-login allocate-port.sh
#   PORT_BASE=30000 PORT_SPAN=500 allocate-port.sh "$(git branch --show-current)"
set -u

ID="${1:-${WORKTREE_ID:-}}"
PORT_BASE="${PORT_BASE:-20000}"
PORT_SPAN="${PORT_SPAN:-1000}"

[ -n "$ID" ] || { echo "ERROR: no worktree id (pass as arg or set WORKTREE_ID)" >&2; exit 2; }

# The range must be plain non-negative integers, or the modulo/offset is
# meaningless and would emit a garbage or out-of-range port silently.
case "$PORT_BASE" in ''|*[!0-9]*) echo "ERROR: PORT_BASE must be a non-negative integer: $PORT_BASE" >&2; exit 2 ;; esac
case "$PORT_SPAN" in ''|*[!0-9]*) echo "ERROR: PORT_SPAN must be a non-negative integer: $PORT_SPAN" >&2; exit 2 ;; esac
[ "$PORT_SPAN" -ge 1 ] || { echo "ERROR: PORT_SPAN must be >= 1: $PORT_SPAN" >&2; exit 2; }

# Keep the whole window inside the usable, non-privileged port space so the
# allocated port is actually bindable: [PORT_BASE, PORT_BASE+PORT_SPAN) must
# lie within 1..65535.
[ "$PORT_BASE" -ge 1 ] || { echo "ERROR: PORT_BASE must be >= 1: $PORT_BASE" >&2; exit 2; }
if [ $((PORT_BASE + PORT_SPAN)) -gt 65536 ]; then
  echo "ERROR: range [PORT_BASE, PORT_BASE+PORT_SPAN) exceeds 65535" >&2
  exit 2
fi

# cksum prints "<crc> <bytes> [name]"; take the CRC. printf (no trailing
# newline) keeps the hash identical whether or not the caller added one.
crc=$(printf '%s' "$ID" | cksum | awk '{print $1}')

port=$(( PORT_BASE + (crc % PORT_SPAN) ))
printf '%s\n' "$port"
