---
release: patch
---

### Fixed

- Test processes remove inherited Git hook repository variables before running,
  and the drive's conflict fixture explicitly uses a clean environment, so
  fixture Git commands cannot be redirected by those variables.
