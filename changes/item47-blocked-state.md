---
release: minor
---

### Added

- An optional `blocked` state in `issue_tracker.states`, for a board that
  shows stopped work as blocked. With it set and the pull request state
  labels on (`dispatch.labels.enabled`), a drive that stops with only parked
  work left (the `jig:parked` label) moves each item its pull request links
  with `Closes <KEY>` or `Refs <KEY>` to `blocked`, with a comment naming
  each park's class (`autonomy.park_classes`) and its reason, and a marker
  recording the state the item left. Once the park is answered and the drive
  runs again, the item returns to that state. The drive moves the items when
  it writes its own state label, and the dispatcher's `--apply` run corrects
  them, under the labels' rules: only where the tracker disagrees, best
  effort, never on a pull request carrying `jig:hold` or `jig:held`. A stop
  blocks an item once, so an item a person moves out of `blocked` stays
  where they put it. A claim refuses an item in `blocked`, a served queue
  never offers one, `work-batch` reads it as started, the parent roll-up
  reads it as work in progress, and `dispatch.states` may not list it.
  Unset, nothing is read or moved.
- `issue_tracker.jira.blocked_fields` (`reason`, `since`): on Jira, the
  fields a blocked item gets, written when it moves to `blocked` and cleared
  when it returns.
