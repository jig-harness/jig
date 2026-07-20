#!/usr/bin/env bash
# Self-test for check-corpus.sh. Asserts a valid corpus passes and each broken
# invariant (duplicate lever, unknown category, unvalidated-but-required,
# missing pin) fails. CI runs it so the corpus gate can't silently break.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-corpus.sh"
fix="$here/fixtures"
tax="$fix/miss-taxonomy.yaml"
rc=0

run() { # <expected-exit> <label> <corpus-file>
  CORPUS="$3" TAXONOMY="$tax" "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run 0 "valid corpus passes"              "$fix/good/corpus.yaml"
run 1 "duplicate lever fails"            "$fix/bad/duplicate-lever.yaml"
run 1 "unknown category fails"           "$fix/bad/unknown-category.yaml"
run 1 "unvalidated required fails"       "$fix/bad/unvalidated-required.yaml"
run 1 "missing pin / bad lever fails"    "$fix/bad/missing-pin.yaml"
run 1 "fake validated record fails"      "$fix/bad/fake-validated.yaml"
run 1 "malformed lever id fails"         "$fix/bad/malformed-lever.yaml"
run 1 "fixture with no lever fails"      "$fix/bad/no-lever.yaml"
run 1 "null pin / empty lens fails"      "$fix/bad/empty-pin-lens.yaml"
run 1 "inline-commented required fails"  "$fix/bad/inline-comment-required.yaml"
run 1 "quoted required key fails"        "$fix/bad/quoted-required.yaml"
run 1 "quoted fixtures key parsed+fails" "$fix/bad/quoted-fixtures.yaml"
run 1 "uppercase boolean required fails" "$fix/bad/uppercase-required.yaml"
run 1 "unparseable required value fails" "$fix/bad/unparseable-required.yaml"
run 2 "absent fixtures collection errors" "$fix/bad/no-fixtures-key.yaml"
run 2 "missing corpus errors"            "$fix/bad/does-not-exist.yaml"

[ "$rc" -eq 0 ] && echo "All corpus-lint self-tests passed." || echo "corpus-lint self-tests FAILED."
exit "$rc"
