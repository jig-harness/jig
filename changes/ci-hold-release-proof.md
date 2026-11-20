---
release: patch
---

### Fixed

- A converged drive retries when GitHub times out while verifying removal of the CI hold label. It keeps the removal record so the next read can verify the event and wait for full CI.
