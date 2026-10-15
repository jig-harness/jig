---
release: patch
---

### Fixed

- The drive-pr test that checks `RunHandle.stop()` empties the process group
  counts a zombie as gone, as `stop()` itself does. It reads the group from
  `/proc` where that answers and from `ps` otherwise, so on a host whose
  PID 1 reaps orphans late, a killed descendant still holding its
  process-table slot after `stop()` returned no longer fails the test.

