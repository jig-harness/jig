---
release: patch
---

### Fixed

- A requested drive restart stays queued while the dispatcher waits for capacity.
  Waiting requests get the next available slot ahead of automatic retries.
