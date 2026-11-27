---
release: patch
---

### Fixed

- drive-pr: a drive under a CI hold no longer waits on `CI_HOLD_WAIT` until it
  stops as stalled when a label event's skipped run is a required check's
  newest run on the head. This happens on a repository whose workflows skip
  the required job on label events, and the drive's own state-label writes
  start such runs. Until the hold is first added, the drive judges the newest
  run of that check that is not a skip, so it adds the hold and pushes. A
  queued or running run is still waited for. A cancelled run is still left to
  the cancelled-run recovery. A skip is never read as a complete run or a
  passing one. After a release, and for the final CI check, the drive still
  judges the newest run. The workflow-convention lint still reports the
  workflow shape, which M13 forbids.
