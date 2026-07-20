#!/usr/bin/env bash
# Self-test for check-required-sections.sh. Asserts: a complete artifact passes
# (via a manifest and via the SECTIONS env), an artifact missing a required
# heading fails and names it, and the usage/format errors (no artifact, missing
# file, no sections given, empty manifest) all exit 2.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-required-sections.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <artifact> <manifest>
  "$gate" "$3" "$4" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

run_env() { # <expected-exit> <label> <artifact> <SECTIONS>
  SECTIONS="$4" "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

grep_out() { # <label> <pattern> <artifact> <manifest>
  if "$gate" "$3" "$4" 2>/dev/null | grep -Eq "$2"; then echo "PASS: $1"
  else echo "FAIL: $1 (missing /$2/)"; rc=1; fi
}

# Manifest path.
run 0 "complete artifact passes (manifest)"   "$fix/good-prd.md" "$fix/sections.txt"
run 1 "missing section fails (manifest)"       "$fix/bad-prd.md"  "$fix/sections.txt"
# A required heading only in frontmatter or an HTML comment is NOT a section.
run 1 "heading only in frontmatter fails"      "$fix/frontmatter-heading.md" "$fix/sections.txt"
run 1 "heading only in HTML comment fails"     "$fix/html-comment-heading.md" "$fix/sections.txt"
run 1 "4-space indented heading (code block) fails" "$fix/indented-heading.md" "$fix/sections.txt"
run 2 "empty manifest errors"                  "$fix/good-prd.md" "$fix/empty-sections.txt"
run 2 "artifact not found errors"              "$fix/nope.md"     "$fix/sections.txt"
run 2 "manifest not found errors"              "$fix/good-prd.md" "$fix/nope.txt"

# SECTIONS env path (pipe-separated one-liner).
run_env 0 "complete artifact passes (SECTIONS env)" "$fix/good-prd.md" "Problem statement|Success metrics"
run_env 1 "missing section fails (SECTIONS env)"     "$fix/bad-prd.md"  "Problem statement|Success metrics"
run_env 0 "matching is case-insensitive"            "$fix/good-prd.md" "PROBLEM STATEMENT|success metrics"

# No required sections at all is a usage error.
"$gate" "$fix/good-prd.md" >/dev/null 2>&1
[ $? -eq 2 ] && echo "PASS: no sections given errors (exit 2)" || { echo "FAIL: no sections given (want 2)"; rc=1; }

# No artifact at all is a usage error.
"$gate" >/dev/null 2>&1
[ $? -eq 2 ] && echo "PASS: no artifact given errors (exit 2)" || { echo "FAIL: no artifact given (want 2)"; rc=1; }

# The failure output names the missing heading, so CI logs are actionable.
grep_out "failure names the missing section" "MISSING required section.*Success metrics" \
         "$fix/bad-prd.md" "$fix/sections.txt"

[ "$rc" -eq 0 ] && echo "All required-sections self-tests passed." || echo "required-sections self-tests FAILED."
exit "$rc"
