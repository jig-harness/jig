---
release: patch
---

### Fixed

- `drive-pr` with `DRIVE_PR_ATTACH=off`: the advice for counting unpushed
  commits after a review quota stop or a pass deadline no longer names
  `@{u}..HEAD` where the tree has no upstream. It reads the same sources the
  leftovers check reads: the upstream when it exists, else the attach
  record's remote ref, else it says no range can be named and gives
  `git log HEAD --branches --not --remotes` to check by hand.
