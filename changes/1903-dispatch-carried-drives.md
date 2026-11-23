---
release: patch
---

### Fixed

- `jig dispatch`: a claimed item whose open pull request's drive is asked for
  but not yet armed (a person's `drive` label, the completed pickup's
  first-drive handoff, or `dispatch.adopt`) is now carried by that pull
  request, shown with its drive waiting to be armed, instead of raised as a
  stalled pickup whose pull request "has no drive" once it idles past
  `dispatch.stalled_after`.
- `jig dispatch`: a stalled pickup relaunched in its own tree
  (`dispatch.stalled_relaunch: finish-once`) now keeps its workspace's
  branch on its launch record, a retried relaunch included, so a relaunched
  process pickup that opens its pull request and hands off the first drive
  (`drive@`) gets that drive armed, as a first launch does.
