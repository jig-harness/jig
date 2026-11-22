---
release: patch
---

### Fixed

- When the forge rate-limits a drive after its stop label is written, the drive
  waits for a reset within its configured bound or records a rate-limited stop
  with the reset time so the dispatcher can resume it.
