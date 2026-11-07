---
release: patch
---

### Fixed

- The drive state reaper reports obsolete file-lock quarantine entries with
  their count and bytes, independently of the clone's import retention. It
  keeps them even after 24 hours without a write: neither an unchanged
  snapshot nor the database mutex excludes suspended legacy writers.
