#!/usr/bin/env bash
# Gate: no issue-tracker references in repository content.
#
# Groundwork's rationale must stand on its own, in module documentation or in
# a comment at the code whose shape needs it. A tracker key ("see ISSUE-123")
# defers the reason to a system most readers cannot open, and it outlives the
# ticket's relevance. Every tracked or non-ignored untracked file is checked,
# vendored material and templates included; binary files are skipped. Out of
# scope: `fixtures/` (deliberately bad self-test inputs) and the one pattern
# file in use (it names the keys it forbids).
#
# Patterns are extended regular expressions, one per line, in
# tracker-key-patterns.txt next to this script ('#' starts a comment).
#
# Fails closed: an invalid pattern, an unreadable root, a failed file listing
# or an unreadable file is an error (exit 2), never a pass.
#
# Usage: check-no-tracker-refs.sh [root-dir] [pattern-file]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ROOT="${1:-.}"
PATTERNS="${2:-$here/tracker-key-patterns.txt}"

die() { echo "check-no-tracker-refs: $*" >&2; exit 2; }

[ -d "$ROOT" ] || die "root is not a directory: $ROOT"
[ -r "$PATTERNS" ] || die "cannot read pattern file: $PATTERNS"
root_abs=$(cd "$ROOT" && pwd -P)
patterns_abs="$(cd "$(dirname "$PATTERNS")" && pwd -P)/$(basename "$PATTERNS")"

# Load and validate each pattern on its own before combining them, so one
# malformed line cannot hide inside the combined expression. Each is wrapped
# in a group, so a trailing escape cannot swallow the separator.
# Read the whole file in one command whose status is checked, so a read
# error can never leave a valid-looking prefix of the patterns in force.
content=$(cat -- "$PATTERNS") || die "cannot read pattern file: $PATTERNS"
regex=""
while IFS= read -r line || [ -n "$line" ]; do
  trimmed="${line#"${line%%[![:space:]]*}"}"
  case "$trimmed" in ''|'#'*) continue ;; esac
  # grep exits 1 for "no match" and 2 for a malformed expression.
  set +e; grep -qE -- "$trimmed" /dev/null; status=$?; set -e
  [ "$status" -le 1 ] || die "invalid pattern in $PATTERNS: $trimmed"
  regex="${regex:+$regex|}($trimmed)"
done <<<"$content"
[ -n "$regex" ] || die "no patterns in $PATTERNS"

# Collect the file list first, NUL-delimited so no filename is quoted or
# split, and check the producer's status before trusting the list.
list=$(mktemp)
trap 'rm -f "$list"' EXIT
if git -C "$root_abs" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$root_abs" ls-files -z --cached --others --exclude-standard >"$list" ||
    die "git ls-files failed under $root_abs"
else
  (cd "$root_abs" && find . -type f -not -path './.git/*' \
    -not -path '*/node_modules/*' -print0) >"$list" ||
    die "find failed under $root_abs"
fi

# True only when the path is absent and its nearest existing ancestor is a
# searchable directory, so its absence is observed rather than inferred.
confirmed_absent() {
  local path=$1 parent
  while [ ! -e "$path" ] && [ ! -L "$path" ]; do
    parent=$(dirname "$path")
    if [ -e "$parent" ]; then
      [ -d "$parent" ] && [ -x "$parent" ]
      return
    fi
    path=$parent
  done
  return 1
}

bad=0
while IFS= read -r -d '' relative; do
  relative="${relative#./}"
  case "$relative" in
    fixtures/*|*/fixtures/*) continue ;;
  esac
  file="$root_abs/$relative"
  [ "$file" = "$patterns_abs" ] && continue
  # Skip only a confirmed deletion. A path that merely cannot be reached
  # (for example behind an unsearchable directory) falls through to grep,
  # which reports it as unreadable. Git's own --deleted list cannot tell the
  # two apart: it reports an unreachable file as deleted.
  if confirmed_absent "$file"; then
    continue
  fi
  # -H names the file itself, so no filename is ever interpolated into code.
  set +e; grep -HInE "$regex" "$file"; status=$?; set -e
  case "$status" in
    0) bad=1 ;;
    1) ;;
    *) die "cannot read $file" ;;
  esac
done <"$list"

if [ "$bad" -ne 0 ]; then
  echo "issue-tracker reference found: state the rationale in the doc or a code comment instead" >&2
fi
exit "$bad"
