---
release: minor
---

### Changed

- Final-CI waiting backs off unchanged observations up to a sixty-second
  scheduling delay while keeping control checks responsive and witness
  expiry based on elapsed time. Forge callers sharing a credential space
  request starts through the shared budget record, with cancellation and
  deadline bounds and recovery after a caller crashes.
