---
release: patch
---

### Fixed

- Opening a workspace for a branch that another checkout holds no longer
  reports that checkout as in use when the idle check ran out of time. A
  command that reached its deadline just as it exited could read as having
  succeeded with no output, so the check took it for a busy checkout and a
  person was told of it; such a command now reads as cut short, and the open
  fails as an ordinary refusal that the next open retries.
