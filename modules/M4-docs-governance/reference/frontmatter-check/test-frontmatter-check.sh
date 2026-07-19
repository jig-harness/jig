#!/usr/bin/env bash
# Self-test for frontmatter-check.sh. Asserts the checker passes clean docs and
# fails each violation class, so the gate can't silently stop matching. CI runs
# it (see ../../../M1-gates-enforcement-ladder/reference/grep-gate).
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/frontmatter-check.sh"
fix="$here/fixtures"
export SCHEMA="$fix/schema.yaml"
rc=0

run() { # <expected-exit> <label> [env NEW_DOCS via 4th arg] <files...>
  local want=$1 label=$2; shift 2
  local newdocs=""
  if [ "$1" = "--new" ]; then newdocs="$2"; shift 2; fi
  NEW_DOCS="$newdocs" "$gate" "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "PASS: $label (exit $got)"
  else echo "FAIL: $label (want $want, got $got)"; rc=1; fi
}

run 0 "valid architecture + adr docs pass"      "$fix/good/caching.md" "$fix/good/adr.md"
run 1 "bad enums/date/tags fail"                "$fix/bad/broken.md"
run 1 "adr missing decision_date fails"         "$fix/bad/adr-missing.md"
run 1 "missing frontmatter fails"               "$fix/bad/nofm.md"
# A doc that lacks `description` passes normally, but fails when treated as a
# NEW doc (description is required only for new docs).
run 0 "no-description doc passes when not new"   "$fix/good/nodesc.md"
run 1 "no-description doc fails when NEW"         --new "$fix/good/nodesc.md" "$fix/good/nodesc.md"

[ "$rc" -eq 0 ] && echo "All frontmatter-check self-tests passed." || echo "Frontmatter-check self-tests FAILED."
exit "$rc"
