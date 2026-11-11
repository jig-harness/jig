---
release: minor
---

### Added

- An optional `pr_open` state in `issue_tracker.states`, for a board that
  separates work being written from work waiting for review. Once an item's
  pull request opens, `/jig:do-item` and `/jig:work-batch` post the comment
  linking it, then move the item to `pr_open`, before the drive arms. The
  parent roll-up reads it as work in progress, never as merged; a claim
  refuses an item in it; the dispatcher's stall and double-claim watch counts
  it as claimed where it has a name of its own; and `dispatch.states` may not list it. It may share its name
  with `in_review` on a tracker with one review status, and that name then
  reads back as `pr_open`: with `do_item.post_merge_state: in_review` too,
  an epic stays `in_progress` after every child has merged, until a person
  closes the children. Unset, no item moves there and nothing changes.
- `do_item.post_merge_state` (`done`, the default, `ops_pending` or
  `in_review`) and `do_item.post_merge_closer`: where the post-merge rule
  stops, for a team whose `done` means merged and verified by someone else,
  and who closes the item, for the closing comment. It applies to an item, each
  sub-issue, an epic's roll-up, `/jig:work-batch after-merge` and the
  follow-up. A value other than `done` needs `pull_requests.issue_link: refs`,
  and the configuration reader refuses it otherwise.
- `tracker.ts transition <key> <state> --post-merge`, which refuses a move to
  `done` that `do_item.post_merge_state` forbids, and `tracker.ts post-merge`,
  which prints the policy. A transition to `pr_open` where it is unset prints
  `skipped` and writes nothing.
- Parent reconciliation and `/jig:work-batch` now describe the policy-dependent
  no-close path when `do_item.post_merge_state` stops short of `done`, so
  extractable tails are moved without claiming that their epic or batch rows
  automatically close.
