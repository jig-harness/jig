---
release: patch
---

### Fixed

- The dispatcher checks the steward's cadence and hourly cap before reading the queue for its digest, so a tick the cadence or the cap rules out reads nothing for it. The digest reuses the queued items the tick already read, and reads the rest only while the tick's deadline leaves room for the launch's preparation and the launch: when time runs out or a read fails, the steward waits for a later tick instead of holding up the tick.
