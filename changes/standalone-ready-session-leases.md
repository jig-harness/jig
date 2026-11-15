---
release: patch
---

### Fixed

- A successful standalone Ready transition releases its session leases so a drive can start immediately in the same working tree. Calls inside a running drive keep its leases. **Consumer action:** none.
