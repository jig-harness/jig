#!/usr/bin/env bash
# Commit-msg gate: require a review-marker tag in the commit message when
# protected paths are staged.
#
# Mechanism: some changes (e.g. database migrations) must pass a mandatory
# review step before they are committed. The reviewer's sign-off is recorded
# as a literal tag in the commit-message body — e.g.
#
#   [reviewed:db-migration]
#
# This hook fails the commit when files matching REVIEW_PATHS_RE are staged
# and the tag is absent. A later gate (CI, or a release check) can re-verify
# the tag on every commit that touches the protected paths, so a local
# bypass (`git commit --no-verify`) changes nothing about what merges.
#
# Why commit-msg and not pre-commit: the commit-message file is only
# populated after pre-commit succeeds. A pre-commit hook that tried to read
# it would always see a stale or missing message and reject every commit.
# Hook managers pass the message file path to commit-msg hooks (lefthook:
# `{1}`; husky/raw git: `$1`).
#
# Why a message-body tag and not git notes: notes do not propagate through
# `git push` by default, so CI (and anyone else's clone) would never see
# them. The message body travels with the commit everywhere.
#
# Configuration (env vars, so the same script serves any marker):
#   REVIEW_MARKER    the literal tag to require   (default: [reviewed:db-migration])
#   REVIEW_PATHS_RE  extended regex for protected staged paths
#                    (default: ^db/migrations/.*\.sql$ — a neutral example)
#
# Usage: check-review-marker.sh <commit-msg-file>
set -u

MSG_FILE="${1:-}"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
  echo "usage: $0 <commit-msg-file>" >&2
  exit 2
fi

MARKER="${REVIEW_MARKER:-[reviewed:db-migration]}"
PATHS_RE="${REVIEW_PATHS_RE:-^db/migrations/.*\.sql\$}"

STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E "$PATHS_RE" || true)
if [ -z "$STAGED" ]; then
  exit 0  # no protected files staged — this commit is unaffected
fi

if grep -qF "$MARKER" "$MSG_FILE"; then
  exit 0
fi

echo ""
echo "ERROR: commit touches protected files but is missing the review marker."
echo ""
echo "  Staged protected files:"
echo "$STAGED" | sed 's/^/    - /'
echo ""
echo "  These files require the mandatory review step for this area."
echo "  After the review, add this line to your commit-message body (verbatim):"
echo ""
echo "      $MARKER"
echo ""
echo "  then re-run 'git commit'."
echo ""
echo "  Escape hatch (emergencies only): git commit --no-verify skips ALL git"
echo "  hooks. Use it only when the review was explicitly deferred via a"
echo "  tracked issue — CI re-checks the marker, so the bypass is visible."
exit 1
