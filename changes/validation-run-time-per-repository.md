---
release: patch
---

### Fixed

- `jig dispatch`'s validation capacity gauge (`load.validation`) charges
  each pass's lock runs, whether still to arrive, at the lock now or
  reserved by a new pickup for the drive after it, its own repository's
  run time, measured once the repository's passes have made five runs,
  instead of the 90th percentile of every run on the host: a repository
  whose passes make short targeted runs is no longer charged another
  repository's full gate runs. A repository without its own measure keeps
  every repository's figure.
- The gauge's runs at once is now at least the slots the test lock's own
  load and memory check admits on the host as the tick reads it, with the
  lock's settled holders taken out of the load, up to `LOCK_SLOTS`, and the
  observed peak where that is higher; the reason names the count, or why it
  was not read.
