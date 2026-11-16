---
release: patch
---

### Changed

- `jig gc`'s tests now cover the worktree `HEAD.lock` it keeps while Orca's
  removal is unsettled. Two cases are new: a collection that takes over an
  ended run's lock and gets Orca's still-deleting answer again, and a step
  that throws after such a takeover. In both, the lock and the launch guard
  claim stay. The collector's behaviour does not change.
