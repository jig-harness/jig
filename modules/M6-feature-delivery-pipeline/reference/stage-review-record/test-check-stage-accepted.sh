#!/usr/bin/env bash
# Self-test for check-stage-accepted.sh. Asserts: a draft and a no-frontmatter
# artifact pass; an accepted artifact passes with either a reviewed: key (a
# reviewer PLUS an anchor) or a non-empty ## Review section; an accepted artifact
# fails when it has no record, an empty ## Review, a bare `reviewed: true`, or a
# lone anchor with no reviewer (date-only or ref-only); a malformed frontmatter
# and a missing file both error (exit 2).
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gate="$here/check-stage-accepted.sh"
fix="$here/fixtures"
rc=0

run() { # <expected-exit> <label> <artifact>
  "$gate" "$3" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$1" ]; then echo "PASS: $2 (exit $got)"
  else echo "FAIL: $2 (want $1, got $got)"; rc=1; fi
}

grep_out() { # <label> <pattern> <artifact>
  if "$gate" "$3" 2>/dev/null | grep -Eq "$2"; then echo "PASS: $1"
  else echo "FAIL: $1 (missing /$2/)"; rc=1; fi
}

# Pass: not-accepted needs no record.
run 0 "draft passes"                      "$fix/draft.md"
run 0 "no-frontmatter passes"             "$fix/no-frontmatter.md"
# Pass: accepted WITH a record (frontmatter key, or a ## Review section).
run 0 "accepted + reviewed key passes"    "$fix/accepted-reviewed.md"
run 0 "accepted + Review section passes"  "$fix/accepted-review-section.md"
# Pass: a reviewer whose name contains a boolean substring is still a reviewer.
run 0 "accepted + reviewer w/ boolean substring passes" "$fix/accepted-reviewer-substring.md"
# Pass: a ## Review section whose content sits inside a fenced block counts.
run 0 "accepted + fenced Review content passes" "$fix/accepted-fenced-content-review.md"
# Fail: accepted WITHOUT a real record.
run 1 "accepted, no record fails"         "$fix/accepted-no-review.md"
run 1 "accepted, empty Review fails"      "$fix/accepted-empty-review.md"
run 1 "accepted, empty fenced Review fails" "$fix/accepted-empty-fence-review.md"
run 1 "accepted, HTML-comment-only Review fails" "$fix/accepted-html-comment-review.md"
run 1 "accepted, bare reviewed:true fails" "$fix/accepted-reviewed-bare.md"
# Fail: an anchor with no accountable reviewer (date-only, or ref/URL-only).
run 1 "accepted, date anchor only fails"  "$fix/accepted-anchor-only.md"
run 1 "accepted, ref anchor only fails"   "$fix/accepted-ref-only.md"
# Fail: reviewer+anchor faked in an inline YAML comment (value is really `true`).
run 1 "accepted, comment-faked review fails" "$fix/accepted-comment-faked-review.md"
# Error: malformed / missing.
run 2 "duplicate status: key errors"      "$fix/accepted-duplicate-status.md"
run 2 "malformed frontmatter errors"      "$fix/malformed.md"
run 2 "missing file errors"               "$fix/does-not-exist.md"

# No artifact at all is a usage error.
"$gate" >/dev/null 2>&1
[ $? -eq 2 ] && echo "PASS: no artifact given errors (exit 2)" || { echo "FAIL: no artifact given (want 2)"; rc=1; }

# The failure output tells the author what to add.
grep_out "failure names the fix" "reviewed:.*or a non-empty ## Review" "$fix/accepted-no-review.md"

[ "$rc" -eq 0 ] && echo "All stage-review-record self-tests passed." || echo "stage-review-record self-tests FAILED."
exit "$rc"
