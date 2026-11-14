---
release: minor
---

### Fixed

- drive-pr: an always-run aggregator check that failed only because a job it
  needs was cancelled, in a run nothing replaced, no longer spends a CI-repair
  pass and stops for `/jig:fix-ci`. When every failing check is a job of a
  workflow run that concluded `cancelled`, the drive recovers that run as it
  recovers a cancelled check: a grace period, then one re-run per head, and
  the `cancelled-ci` park when that does not recover it. A real failure comes
  back from the re-run and is repaired then.
- drive-pr: a failed read of the pull request or its label timeline while
  the drive releases the CI hold at convergence (a forge timing out) now ends
  the drive with `4`, wait and re-arm, instead of `1`, and the driver log
  keeps what the release printed, the forge's own error included.
