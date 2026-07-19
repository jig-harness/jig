#!/bin/sh
# check-referenced-paths.sh — referenced-path-exists check for prose files.
#
# Instruction files reference repo paths in prose (markdown links, inline
# code spans). When a file moves or is renamed, the reference rots silently.
# This check extracts path-like references and fails when one resolves to no
# file or directory. Commits nothing; recomputes reality on every run.
#
# Extraction is deliberately CONSERVATIVE: a candidate is only checked when
# it looks unambiguously like a path (contains a slash, or is an explicit
# ./ or ../ relative reference), and candidates containing placeholders
# (<name>, {var}, $VAR), globs, URLs, or spaces are skipped as unresolvable.
# For an advisory check, a false negative (a broken path we skipped) is
# acceptable; a false positive (flagging `and/or` or a shell command) is
# not — tune the filters for your repo before promoting to blocking.
#
# Candidates resolve relative to the prose file's own directory first, then
# relative to the current working directory (run it from the repo root).
#
# Usage:
#   sh check-referenced-paths.sh <prose-file> [<prose-file>...]
#
# Exit codes: 0 = every extracted reference resolves; 1 = at least one broken.
set -eu

[ "$#" -ge 1 ] || { echo "usage: check-referenced-paths.sh <prose-file>..." >&2; exit 2; }

MISSING=$(mktemp)
trap 'rm -f "$MISSING"' EXIT INT TERM
CHECKED=0

# Pull markdown-link targets and inline `code` spans out of one line.
extract_candidates() {
  # [text](target)  →  target
  printf '%s\n' "$1" | grep -oE '\]\([^)]+\)' | sed 's/^](//; s/)$//' || true
  # `span`  →  span
  printf '%s\n' "$1" | grep -oE '`[^`]+`' | tr -d '`' || true
}

for FILE in "$@"; do
  [ -f "$FILE" ] || { echo "error: no such file: $FILE" >&2; exit 2; }
  FILE_DIR=$(dirname -- "$FILE")
  lineno=0
  in_fence=0

  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))

    # Skip fenced code blocks: example links/paths inside ``` fences are
    # illustrations, not live references.
    case "$line" in
      '```'*) if [ "$in_fence" -eq 0 ]; then in_fence=1; else in_fence=0; fi
              continue ;;
    esac
    [ "$in_fence" -eq 1 ] && continue

    # Word-splitting on the candidate list is safe: anything containing
    # whitespace is rejected by the filters below anyway.
    for cand in $(extract_candidates "$line"); do
      # Drop anchors/queries; trim trailing sentence punctuation.
      cand=$(printf '%s\n' "$cand" | sed 's/[#?].*$//; s/[.,;:)]*$//')
      [ -n "$cand" ] || continue

      # Conservative filters — skip anything that is not unambiguously a
      # concrete repo path.
      case "$cand" in
        *://*|http:*|https:*|mailto:*) continue ;;   # URLs
        *'<'*|*'{'*|*'$'*)             continue ;;   # placeholders
        *'*'*|*'?'*|*'['*)             continue ;;   # globs
        *' '*)                         continue ;;   # spaced: prose, commands
        */*)                           : ;;          # has a slash: check it
        *)                             continue ;;   # bare word: ambiguous
      esac

      CHECKED=$((CHECKED + 1))
      # Resolve relative to the prose file, then to the working directory.
      if [ -e "$FILE_DIR/$cand" ] || [ -e "$cand" ]; then
        continue
      fi
      printf '%s:%s  %s\n' "$FILE" "$lineno" "$cand" >> "$MISSING"
    done
  done < "$FILE"
done

if [ -s "$MISSING" ]; then
  echo "ERROR: prose references paths that exist in no tree:" >&2
  sed 's/^/  /' "$MISSING" >&2
  echo '' >&2
  echo "A moved or renamed target rots the reference silently. Update the" >&2
  echo "reference, or (if intentional) rephrase so it is not extracted as" >&2
  echo "a concrete path." >&2
  exit 1
fi

echo "OK: all $CHECKED extracted path reference(s) resolve."
