#!/usr/bin/env bash
# Auditor v1 scoring aid — turn the modules' maturity.yaml criteria into a
# ready-to-fill scoring checklist, so a "scored maturity assessment" is a
# mechanical read of the criteria rather than a from-memory exercise.
#
# Every module now ships machine-evaluable criteria (modules/README.md §
# "maturity.yaml schema"): each criterion carries an id, the maturity `level`
# where it first becomes required (lite | standard | strict), the `requires`
# rung (convention | mechanical), and a one-sentence observable `statement`.
# This script reads them all and emits one markdown table per module with an
# empty Score and Evidence column for the auditor to fill in against a target
# repo (paste into the report under "Module scores").
#
# Two modes:
#   score-modules.sh [modules-dir]      # default: print the fill-in checklist
#   score-modules.sh --check [modules-dir]
#       # coverage gate: every M0..M12 has a maturity.yaml with >=1 criterion.
#       # Dogfoodable — fails loudly if a module port forgot its criteria.
#
# Portable: bash + awk + coreutils. Exit 0 ok, 1 --check failure, 2 usage.
set -u

mode="print"
if [ "${1:-}" = "--check" ]; then mode="check"; shift; fi

MODULES="${1:-}"
if [ -z "$MODULES" ]; then
  # default: modules/ relative to this script's parent (repo root)
  here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  MODULES="$(dirname "$here")/modules"
fi
[ -d "$MODULES" ] || { echo "ERROR: modules dir not found: $MODULES" >&2; exit 2; }

# Emit, per maturity.yaml, tab-separated rows:  module<TAB>id<TAB>level<TAB>requires<TAB>statement
# plus a header row  module<TAB>__name__<TAB>name  so the printer can title sections.
extract() {  # <maturity.yaml>
  awk '
    function flush(){ if(id!=""){ gsub(/[[:space:]]+$/,"",st);
      printf "%s\t%s\t%s\t%s\t%s\n", mod, id, level, req, st } id=""; level=""; req=""; st="" }
    /^[[:space:]]*#/ { next }
    /^module:/ { mod=$2; next }
    /^name:/   { printf "%s\t__name__\t\t\t%s\n", mod, $2; next }
    /^  - id:/ { flush(); id=$3; capt=0; next }
    /^    level:/    { level=$2; capt=0; next }
    /^    requires:/ { req=$2; capt=0; next }
    /^    statement:/ { capt=1; next }
    /^    observe:/  { capt=0; next }
    /^    [a-z]/     { capt=0; next }      # any other 4-space key ends the statement
    capt==1 && /^      / { line=$0; sub(/^[[:space:]]+/,"",line);
                           st = (st=="" ? line : st " " line); next }
    END { flush() }
  ' "$1"
}

# Collect every module maturity file in numeric module order (M0..M12), not the
# lexical M0,M1,M10,M11,M12,M2,... a plain sort would give. Pad the module
# number to sort numerically, then strip the pad.
files=$(find "$MODULES" -mindepth 2 -maxdepth 2 -name maturity.yaml \
  | awk -F/ '{ d=$(NF-1); n=d; sub(/^M/,"",n); sub(/-.*/,"",n)
              printf "%09d\t%s\n", n+0, $0 }' \
  | sort -k1,1n | cut -f2-)

if [ "$mode" = "check" ]; then
  rc=0
  for n in $(seq 0 12); do
    f=$(printf '%s\n' "$files" | grep -E "/M${n}-[^/]*/maturity.yaml$" | head -1)
    if [ -z "$f" ]; then echo "MISSING: M${n} has no maturity.yaml"; rc=1; continue; fi
    c=$(extract "$f" | awk -F'\t' '$2!="__name__" && $2!=""' | wc -l | tr -d ' ')
    if [ "$c" -lt 1 ]; then echo "EMPTY: M${n} ($f) has no criteria"; rc=1
    else echo "ok: M${n} — $c criteria"; fi
  done
  [ "$rc" -eq 0 ] && echo "All 13 modules (M0–M12) carry machine-evaluable criteria."
  exit "$rc"
fi

# print mode — a fill-in scoring checklist grouped by module.
echo "# Module scoring checklist (auditor v1)"
echo
echo "Generated from each module's \`maturity.yaml\`. For every criterion, record"
echo "the observed rung — \`absent\` / \`convention\` / \`advisory\` / \`mechanical\` —"
echo "with a file-path evidence note. A module attains a maturity level when every"
echo "criterion at that level *and below* meets its \`requires\` rung."
echo
for f in $files; do
  rows=$(extract "$f")
  mod=$(printf '%s\n' "$rows" | head -1 | cut -f1)
  name=$(printf '%s\n' "$rows" | awk -F'\t' '$2=="__name__"{print $5; exit}')
  echo "## ${mod} — ${name}"
  echo
  echo "| Criterion | Level | Requires | Score | Evidence |"
  echo "|-----------|-------|----------|-------|----------|"
  printf '%s\n' "$rows" | awk -F'\t' '$2!="__name__" && $2!="" {
    printf "| %s | %s | %s |  |  |\n", $2, $3, $4 }'
  echo
done
