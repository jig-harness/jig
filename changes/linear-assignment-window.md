---
release: patch
---

### Changed

- `jig dispatch` now says why it refuses a Linear issue whose history holds no
  assignment: Linear omits property changes made in an issue's first three
  minutes, so the refusal names that window and says to wait until the issue is
  older than that, then unassign it and assign it again to start a pickup.
