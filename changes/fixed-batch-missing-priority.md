---
release: patch
---

### Fixed

- A fixed batch's pass decides whether a member whose priority was cleared
  after the tick may start with the `dispatch.missing_priority` the
  dispatcher read from the default branch, not with the setting in its
  workspace's `.config/jig.yaml`, which a reused workspace could carry
  unreviewed. A batch's launch record gains an optional `missingPriority`
  field (`hold` or `start`), written only on a batch's record; a record
  without it reads as before, and its pass decides as under `hold`. The
  pass's prompt hands the value to `work-batch`'s proposal as
  `candidates.ts --fixed … --missing-priority <value>`, and the proposal now
  names the member to work alone when fewer than two stay (`alone` in its
  JSON form, with each left-out member's `noPriority`), or none, with the
  members held for their missing priority.
