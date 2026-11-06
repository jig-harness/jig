---
release: patch
---

### Fixed

- The drive state reaper reports obsolete file-lock quarantine entries with
  their count and bytes, and retires them after 24 hours without a write when
  no legacy lock remains, independently of the clone's import retention.
