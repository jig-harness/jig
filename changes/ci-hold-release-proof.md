---
release: patch
---

### Fixed

- A converged drive retries when GitHub times out while verifying removal of the CI hold label. It keeps the removal record so the next read can verify the event and wait for full CI, then stops after the configured consecutive proof-read limit instead of retrying forever.
- CI hold release recovery now emits its retry marker once and refuses a proven ownership race before an unreadable confirmation can hide it.
