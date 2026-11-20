---
release: patch
---

### Fixed

- A parked drive's review thread is now read with its pull request's
  repository named, by the dispatcher's tick and by `jig ask`. On a host
  where the GitHub account is chosen by the repository a call addresses, the
  read used to run as the default login and was answered `not-found` for a
  repository owned by another account, so every timer tick exited 1 for as long
  as such a drive stayed parked, and a person's answer to its park was never
  read.
- A parked drive's review thread that the forge answers `not-found`, such as
  one the credential cannot see, no longer fails the repository's turn or the
  tick. The item's row in the report still carries the class, the failure
  ledger counts nothing and nobody is told. Any other `not-found` read of one
  item, such as a base branch that is gone, and a `not-found` of a repository's
  own record, still fail the turn.
