---
release: patch
---

### Fixed

- Reset preserves a live Ready-mark lease, preventing a duplicate Ready transition while its outcome is pending. Stale leases can still be cleared by reset.
