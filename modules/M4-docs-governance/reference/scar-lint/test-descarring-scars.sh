#!/usr/bin/env bash
# Self-test for check-descarring-scars.sh. Asserts scars are caught in approved
# docs and every false-positive guard holds (drafts exempt, code masked,
# allowlist/descar_allow honored). CI runs this as a BLOCKING step even when the
# scar scan itself is advisory — proving the gate works is what makes an
# advisory scan trustworthy.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-descarring-scars.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <files...>
  local want=$1 label=$2; shift 2
  "$gate" "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "PASS: $label (exit $got)"
  else echo "FAIL: $label (want $want, got $got)"; rc=1; fi
}

run 0 "clean approved doc passes"                 "$fix/clean.md"
run 1 "scarred approved doc fails"                "$fix/scarred.md"
run 0 "draft with scars is exempt"                "$fix/draft.md"
run 0 "doc documenting scar syntax (masked) passes" "$fix/documents-syntax.md"
run 0 "descar_allow doc passes"                   "$fix/allowed.md"

[ "$rc" -eq 0 ] && echo "All scar-lint self-tests passed." || echo "Scar-lint self-tests FAILED."
exit "$rc"
