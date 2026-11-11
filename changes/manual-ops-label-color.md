---
release: patch
---

### Fixed

- The manual-operations label (`manual-ops` by default) is created purple, and
  a test keeps it apart from the red `jig:parked` and `jig:followup-failed`:
  a pull request that owes a step outside the code is not stopped or blocked.
  A repository that created the label in red keeps that color until someone
  changes it (`gh label edit manual-ops --color 5319e7`).
