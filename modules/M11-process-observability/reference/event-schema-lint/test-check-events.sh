#!/usr/bin/env bash
# Self-test for check-events.sh. Asserts a valid stream passes, an empty stream
# passes, an unknown type and a missing/empty required field fail (exit 1), and
# malformed events or a malformed schema error (exit 2). CI runs it so the event
# gate can't silently break.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-events.sh"
fix="$here/fixtures"
schema="$fix/schema.yaml"
rc=0

run() { # <expected-exit> <label> <events-file> [schema-file]
  local sch="${4:-$schema}"
  SCHEMA="$sch" "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

grep_out() { # <label> <pattern> <events-file>
  if SCHEMA="$schema" "$gate" "$3" 2>&1 | grep -Eq "$2"; then echo "PASS: $1"
  else echo "FAIL: $1 (missing /$2/)"; rc=1; fi
}

# validation outcomes
run 0 "valid stream passes"            "$fix/good/events.log"
run 0 "empty stream passes"            "$fix/empty.log"
run 1 "unknown event type fails"       "$fix/bad/unknown-type.log"
run 1 "missing required field fails"   "$fix/bad/missing-required.log"
run 1 "empty required field fails"     "$fix/bad/empty-required.log"

# format / usage errors
run 2 "malformed token errors"         "$fix/bad/malformed-token.log"
run 2 "event with no type= errors"     "$fix/bad/no-type.log"
run 2 "missing events file errors"     "$fix/bad/does-not-exist.log"

# malformed schema errors even over a good stream
run 2 "schema with no required errors" "$fix/good/events.log" "$fix/bad/schema-no-required.yaml"
run 2 "schema with no types errors"    "$fix/good/events.log" "$fix/bad/schema-no-types.yaml"
run 2 "schema duplicate type errors"   "$fix/good/events.log" "$fix/bad/schema-duplicate-type.yaml"
run 2 "schema duplicate required errors" "$fix/good/events.log" "$fix/bad/schema-duplicate-required.yaml"
run 2 "missing schema file errors"     "$fix/good/events.log" "$fix/does-not-exist.yaml"

# the report names the offending type / field
grep_out "names the unregistered type"  "unregistered event type .gate_reslt." "$fix/bad/unknown-type.log"
grep_out "names the missing field"       "missing required field .outcome."     "$fix/bad/missing-required.log"

[ "$rc" -eq 0 ] && echo "All event-schema-lint self-tests passed." || echo "event-schema-lint self-tests FAILED."
exit "$rc"
