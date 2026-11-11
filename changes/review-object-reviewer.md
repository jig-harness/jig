---
release: minor
---

### Added

- `drive-pr` reads an AI reviewer that submits pull-request reviews instead of
  a summary comment with a reviewed-SHA stamp (`review.reviewer_evidence:
  review_object`). A review naming the head, or the reviewer's check run
  completed on the head with no later review, is a review of the head; a run
  titled `Review paused…` or `Review skipped…` stops the drive with
  `REVIEW_SKIPPED` (`22`), the reason naming which and quoting the title. On
  a draft the reviewer skips, the draft converges on its own work, and the
  drive marks it Ready and waits for that review
  ([terminal states](../plugin/skills/drive-pr/references/terminal-states.md#a-reviewer-that-submits-pull-request-reviews)).
- CodeRabbit is a built-in reviewer: `review.reviewer_app: coderabbitai`
  alone sets its check name (`^CodeRabbit$`) and its evidence, for the drive
  and for the dispatcher's merge-ready board.
- `review.draft_skipping_reviewers` names the reviewers that skip drafts; the
  merge-ready announcement waits (exit `4`) until each has run on the head
  since the pull request was last marked Ready
  ([fields](../plugin/CONFIGURATION.md#review)).
- `arm-drive.ts` refuses a configuration whose reviewer evidence the drive
  cannot read (`review_object` without `review.reviewer_app` where a reviewer is expected, or `sticky` for
  CodeRabbit), and the audit reports it as an error, rather than a drive
  waiting in `AWAITING_REVIEWER` until its timeout.

### Fixed

- The merge-ready announcement no longer vouches for a head a reviewer that
  skips drafts has not looked at since the pull request was marked Ready,
  where `review.draft_skipping_reviewers` names that reviewer.
