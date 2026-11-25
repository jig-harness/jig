---
release: patch
---

### Fixed

- End an expired pull-request poll with exit `4` even when the deadline
  prevents the next read. Preserve diagnostics from failed reads and retry a
  drive that stopped on a probe read failure once per pull-request head.
