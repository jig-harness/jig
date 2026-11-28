---
release: patch
---

### Fixed

- The review drive can finish on an unchanged pull request when a label event
  skips a required check that already ran on the current commit and the pull
  request has never had the CI hold label.

### Changed

- The configuration reference explains when a reviewer that skips drafts can
  delay the merge-ready announcement after the drive converges.
