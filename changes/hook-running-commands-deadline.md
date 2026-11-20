---
release: patch
---

### Fixed

- `/jig:resolve-conflicts` no longer loses its concluding commit in a
  repository whose git hooks run longer than two minutes. Its commits, its
  merge and `git rebase --continue` run the repository's hooks under an
  hour's deadline instead of the command wrapper's 120 seconds, and Step 7
  now says how to finish from a command killed at its deadline (exit `124`):
  what it leaves, and the retry under a longer deadline that still ends a
  hook that hangs. `/jig:fix-ci`'s commit and the merge drive-pr prints for
  a conflicting base get the same deadline.
