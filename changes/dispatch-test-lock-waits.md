---
release: patch
---

### Fixed

- The dispatcher attributes test-lock waits to the launch running validation and reports how long it has waited. Drift, ended-pickup and stalled-pickup reasons retain the last observed wait, so a queued suite is visible when a pass reaches its deadline.
  Attribution currently works on POSIX; Windows announcements are neither attributed nor counted as waiters until process creation time can be verified there.
