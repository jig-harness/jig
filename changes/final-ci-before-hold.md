---
release: patch
---

### Fixed

- The review drive can finish on an unchanged pull request when a label event
  skips a required check that already ran on the current commit and the pull
  request has never had the CI hold label.
