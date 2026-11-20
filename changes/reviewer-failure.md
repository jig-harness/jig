---
release: patch
---

### Fixed

- Drives stop promptly when the configured reviewer reports that it gave up
  on the current head. While a review is pending, the drive backs off its
  forge polls. After repeated reviewer failures on the same head, the
  dispatcher raises one need and waits for a review or a new head.
- A malformed optional reviewer-evidence field no longer makes an otherwise
  usable drive ledger unreadable during recovery.
