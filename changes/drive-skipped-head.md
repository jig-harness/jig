---
release: minor
---

### Added

- A drive reads the reviewer's skip notice: a block in its sticky comment,
  marked `review.skip_notice_marker` (default `ai-review-skip-notice`,
  `DRIVE_PR_SKIP_NOTICE_MARKER` overrides it), saying it did not review a
  pushed head. A skipped head whose pull-request diff equals the diff at the
  head the reviewer last reviewed, such as a merge of the base branch, is
  judged on that review: the report names the earlier head as the reviewed
  one (`reviewedShaSource: "skip-notice"`) and the skip as the reason, and
  the drive can converge
  ([terminal states](../plugin/skills/drive-pr/references/terminal-states.md)).
- A new terminal state, `REVIEW_SKIPPED` (exit `22`): the reviewer skipped
  the head, and its earlier review does not cover it because the pull
  request's diff changed: the diffs are compared with their context and with
  binary files by content, so a merge that moved or edited the change's
  lines differs. A commit the comparison needs that the clone lacks is
  fetched once; still missing, the evaluation is `INDETERMINATE` (exit `1`)
  and runs again. The stop quotes the
  notice and says what a person does next; `jig dispatch` hands it to a
  person and labels the pull request parked, rather than re-arming it at the
  same head. A harness that reads the drive's exit codes should treat `22`
  as a stop for a person.

### Fixed

- A drive no longer waits as `STALE_REVIEW` (exit `4`) for as long as a head
  stands when the reviewer has said it will not review that head; a
  dispatcher re-armed such a drive at the same head indefinitely.
