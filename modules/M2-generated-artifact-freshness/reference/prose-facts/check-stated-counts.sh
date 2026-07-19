#!/bin/sh
# check-stated-counts.sh — rung-2 commit-nothing check for derivable counts.
#
# Instruction files sometimes state COUNTABLE facts in prose ("12 guides
# total"). Hand-written, such a count drifts silently the moment a file is
# added or removed. This check re-derives the true count from its source of
# truth (here: markdown files under a directory), scans the prose for stated
# copies, and fails when a stated copy DISAGREES. Nothing is written to disk
# — there is no generated cache at rest, so nothing can merge-conflict.
#
# It flags DRIFT, not PRESENCE: if the prose states no count, there is
# nothing to check — dropping the number entirely (rung 1) is the preferred
# outcome.
#
# Patterns are anchored to an inventory qualifier ("N <noun> total /
# available / listed") so incidental prose ("spawn 3 workers") is never
# flagged. For an advisory check, a false negative is acceptable; a false
# positive is not.
#
# Usage:
#   sh check-stated-counts.sh <prose-file> <source-dir> <noun>
#   e.g. sh check-stated-counts.sh fixture/instructions.md fixture/guides guides
#
# Exit codes: 0 = every stated copy matches (or none stated); 1 = drift.
set -eu

FILE="${1:?usage: check-stated-counts.sh <prose-file> <source-dir> <noun>}"
DIR="${2:?usage: check-stated-counts.sh <prose-file> <source-dir> <noun>}"
NOUN="${3:?usage: check-stated-counts.sh <prose-file> <source-dir> <noun>}"

[ -f "$FILE" ] || { echo "error: no such file: $FILE" >&2; exit 2; }
[ -d "$DIR" ]  || { echo "error: no such directory: $DIR" >&2; exit 2; }

# Derive the true value from the source of truth. Pure read; writes nothing.
DERIVED=$(find "$DIR" -name '*.md' ! -name 'index.md' | wc -l | tr -d ' ')

PATTERN="[0-9][0-9]* $NOUN (total|available|listed)"

# Collect drift findings in a temp file: the grep|while pipeline runs in a
# subshell in POSIX sh, so a plain variable could not carry state out of it.
DRIFTS=$(mktemp)
trap 'rm -f "$DRIFTS"' EXIT INT TERM

grep -nE "$PATTERN" "$FILE" 2>/dev/null | while IFS=: read -r lineno rest; do
  # Extract the stated number from the MATCHED phrase (not the whole line,
  # whose leading text may contain unrelated digits). This simple version
  # checks the first stated copy per line.
  stated=$(printf '%s\n' "$rest" \
    | grep -oE "$PATTERN" | head -n 1 | grep -oE '^[0-9]+')
  [ -n "$stated" ] || continue
  if [ "$stated" -ne "$DERIVED" ]; then
    printf '%s:%s states %s %s, but the source of truth (%s) has %s\n' \
      "$FILE" "$lineno" "$stated" "$NOUN" "$DIR" "$DERIVED" >> "$DRIFTS"
  fi
done

if [ -s "$DRIFTS" ]; then
  echo "ERROR: stated counts have drifted from their source of truth:" >&2
  sed 's/^/  /' "$DRIFTS" >&2
  echo '' >&2
  echo "A hand-written derivable count drifts silently. Prefer to DROP the" >&2
  echo "number and let the enumeration speak; if it carries real value," >&2
  echo "keep it correct — but do NOT commit a generated cache of it (that" >&2
  echo "trades drift for merge-conflict churn)." >&2
  exit 1
fi

echo "OK: derived $DERIVED $NOUN; no stated copy in $FILE disagrees."
