#!/usr/bin/env bash
# ADR numbering gate: no two ADRs may claim the same number.
#
# Born from a real collision — two agents on parallel branches both picked the
# same "next" ADR number (next-number selection is inherently racy: it reads
# the current max and adds one). A merge then silently produced two ADR-00NN
# files. This gate makes that fail loudly. Mirror it client-side (pre-push) AND
# server-side (CI) so `--no-verify` or automation bypassing local hooks can't
# ship a duplicate — CI is the authority (see M1).
#
# It only checks numbers, not slugs: ADR-0007-a.md and ADR-0007-b.md collide.
# Gaps in the sequence are fine (a withdrawn ADR leaves a hole).
#
# Conventions: exit 0 on pass, 1 on a duplicate; ADR_DIR via env so the paired
# self-test can point at fixtures; a missing dir passes (safe to wire early).
#
# Usage:
#   check-adr-numbers.sh
#   ADR_DIR=path/to/adr check-adr-numbers.sh
set -u
ADR_DIR="${ADR_DIR:-docs/adr}"

if [ ! -d "$ADR_DIR" ]; then
  echo "OK — $ADR_DIR does not exist (no ADRs to check)"
  exit 0
fi

# Extract the ADR-NNNN prefix from each filename; keep only duplicates.
dupes=$(find "$ADR_DIR" -maxdepth 1 -name 'ADR-*.md' 2>/dev/null \
  | sed 's#.*/##' \
  | sed -E 's/^(ADR-[0-9]+).*/\1/' \
  | sort | uniq -d)

if [ -n "$dupes" ]; then
  echo "ERROR: duplicate ADR numbers found in $ADR_DIR"
  echo ""
  echo "Two files claim the same number. Renumber one to the next free number."
  echo "Duplicated numbers:"
  printf '%s\n' "$dupes" | sed 's/^/  /'
  echo ""
  echo "Offending files:"
  for n in $dupes; do
    find "$ADR_DIR" -maxdepth 1 -name "$n-*.md" | sed 's#^#  #'
  done
  exit 1
fi

echo "OK — ADR numbers unique in $ADR_DIR"
