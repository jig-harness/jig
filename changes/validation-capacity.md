---
release: minor
---

### Added

- Dispatch receipts show when work already in flight would exhaust the host's test-lock capacity. The validation gauge learns from lock releases, reserves room for a drive pass, and follows the host's existing load enforcement setting.
