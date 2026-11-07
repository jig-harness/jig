---
release: patch
---

### Fixed

- The dispatcher now reports silent drives through notifications, `jig ask --waiting` and a parked state label. With re-arms enabled, it recovers a confirmed-dead local driver from a released witness or persisted pass observations before planning a retry within the no-cause budget, including hand-armed drives killed abruptly. Pending launches, surviving work, unreadable liveness and legacy acquisitions without termination evidence still require inspection.
- Doctor and stop recovery use a temporary session and release their own PR and tree leases, so a diagnostic cannot leave the calling session blocking the replacement driver.
