---
release: patch
---

### Fixed

- `drive-pr`: after a person answers the `cancelled-ci` park with "Re-run
  safely", the drive no longer parks again on cancelled runs it never re-ran.
  The recovery now records the runs it re-runs and judges those: it waits
  while their new attempts are queued or running, for up to ten minutes for
  an attempt to appear (it was one minute), and parks only when a re-run run
  shows no new attempt or result, naming those runs and what it saw of each.
  A run of the same workflow cancelled in the meantime, such as one a label
  event started and the workflow's concurrency group cancelled, is answered
  by the re-run's result. A cancelled workflow the request did not cover is
  re-run once on its own, and a later answer re-runs only what is still
  without a result.
