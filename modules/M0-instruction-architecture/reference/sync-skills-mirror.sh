#!/bin/sh
# sync-skills-mirror.sh — cross-runtime skill discovery via a symlink mirror.
#
# Problem: skills (packaged agent procedures) are authored once, but agent
# runtimes scan different directories — e.g. Claude Code scans
# .claude/skills/, OpenAI Codex scans .agents/skills/ (and follows
# symlinks). Duplicating the files creates a second source of truth that
# drifts.
#
# Mechanism: keep ONE canonical directory (default: .claude/skills/, each
# skill a folder containing SKILL.md) and maintain the other directory as a
# symlink farm pointing back at it, one link per skill:
#
#   .agents/skills/<name> -> ../../.claude/skills/<name>
#
# Recipe for adoption:
#   1. Commit only the canonical directory. GITIGNORE the mirror
#      (".agents/skills/" in .gitignore) — committed symlinks are a second
#      source of truth that drifts, and symlinks-in-git are fragile across
#      platforms. The mirror is derived state, regenerated locally.
#   2. Run this script from a package-manager postinstall hook (or your
#      setup script) so every install refreshes the mirror. A fresh clone
#      needs one install before the second runtime can discover skills;
#      CI usually doesn't need the mirror at all.
#   3. Optionally run `sync-skills-mirror.sh --check` from a pre-push hook
#      as a sanity gate: it reports drift and exits 1 without changing
#      anything.
#
# The script is idempotent: running it twice produces the same result, and
# --check immediately after a sync always exits 0.
#
# Usage:
#   sh sync-skills-mirror.sh            # sync (create/fix/remove links)
#   sh sync-skills-mirror.sh --check    # report-only; exit 1 on drift
#
# Configuration (override via environment):
#   CANONICAL_DIR  source of truth       (default .claude/skills)
#   MIRROR_DIR     symlink farm          (default .agents/skills)
#
# Requires: POSIX sh + git. Windows note: symlinks need Developer Mode or
# an elevated shell; on such setups prefer running the second runtime
# against the canonical directory directly, or copy instead of link.

set -eu

CANONICAL_DIR="${CANONICAL_DIR:-.claude/skills}"
MIRROR_DIR="${MIRROR_DIR:-.agents/skills}"

# Strip trailing slashes: an empty trailing segment would inflate the "../"
# count below, and since `want` is computed from the same value, --check
# would then report a broken mirror as in sync.
CANONICAL_DIR="${CANONICAL_DIR%/}"
MIRROR_DIR="${MIRROR_DIR%/}"

# Run from repo root so relative link targets are stable.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: not inside a git repository" >&2; exit 1;
}
cd "$REPO_ROOT"

# Relative path from inside MIRROR_DIR back to repo root (one ".." per
# path segment), then down into CANONICAL_DIR.
UPS=$(printf '%s\n' "$MIRROR_DIR" | awk -F/ '{ for (i=1;i<=NF;i++) printf "../" }')
RELATIVE_TARGET="${UPS}${CANONICAL_DIR}"

CHECK_MODE=false
[ "${1:-}" = "--check" ] && CHECK_MODE=true

drift=0

# --- 1. Every canonical skill has a correct symlink -------------------
found_any=false
for dir in "$CANONICAL_DIR"/*/; do
  [ -f "${dir}SKILL.md" ] || continue
  found_any=true
  name="$(basename "$dir")"
  link="$MIRROR_DIR/$name"
  want="$RELATIVE_TARGET/$name"

  if [ -L "$link" ] && [ "$(readlink "$link")" = "$want" ]; then
    continue
  elif [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "ERROR: $link exists as a regular file/directory, not a symlink — remove manually" >&2
    drift=1
  elif [ "$CHECK_MODE" = true ]; then
    echo "DRIFT: $link should link to $want"
    drift=1
  else
    mkdir -p "$MIRROR_DIR"
    rm -f "$link"
    ln -s "$want" "$link"
    echo "  + $link -> $want"
  fi
done

if [ "$found_any" = false ]; then
  # An empty canonical dir means misconfiguration (or wrong tree) — fail
  # hard so --check can't silently pass on a missing skill set.
  echo "ERROR: no skills found in $CANONICAL_DIR (expected <name>/SKILL.md)" >&2
  exit 1
fi

# --- 2. No stale mirror entries (links whose source is gone) ----------
# Note: glob without trailing slash so BROKEN symlinks are caught too.
if [ -d "$MIRROR_DIR" ]; then
  for entry in "$MIRROR_DIR"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue   # unmatched glob
    [ -L "$entry" ] || continue                       # non-links flagged above
    name="$(basename "$entry")"
    if [ ! -f "$CANONICAL_DIR/$name/SKILL.md" ]; then
      if [ "$CHECK_MODE" = true ]; then
        echo "DRIFT: stale $entry (no $CANONICAL_DIR/$name)"
        drift=1
      else
        rm "$entry"
        echo "  - $entry (stale)"
      fi
    fi
  done
fi

if [ "$drift" -ne 0 ]; then
  echo "FAIL — run 'sh $0' to fix" >&2
  exit 1
fi
echo "OK — $MIRROR_DIR in sync with $CANONICAL_DIR"
