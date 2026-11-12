---
release: minor
---

### Changed

- A tracker with one review status, where `issue_tracker.states` gives
  `pr_open` and `in_review` the same name, no longer keeps its epics in
  progress after every child has merged. `do-item`'s parent roll-up (Step
  5a, which `work-batch after-merge` and the post-merge follow-up run too)
  reads each child under that name by its linked pull request: merged into
  the integration branch, it counts as `in_review`, merged and parked; open,
  missing, or unreadable, it counts as `pr_open` and keeps the epic in
  progress. With `do_item.post_merge_state: in_review`, an epic whose
  children have all merged now rolls up to `in_review`. Distinct names read
  nothing from the code host and behave as before.

### Added

- `do-item`'s `scripts/linked-pr.ts` reads whether each item's linked pull
  request merged, finding it through the pull-request link in the item's
  comments or the `Closes <KEY>` / `Refs <KEY>` line in a pull request's
  body. A read that fails answers `unreadable`, which never moves an epic.
