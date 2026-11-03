---
release: patch
---

### Fixed

- `drive-pr` no longer spends its CI-repair passes on a cancelled check. A check
  concluded `cancelled`, and a job of a cancelled workflow run that failed only
  because other jobs were cancelled, read as `cancelled: …`: an absence of
  evidence. The drive waits for a run to replace it, on
  `DRIVE_PR_FINAL_CI_WITNESS_POLLS`, and once a run of the same workflow on the
  head has completed with a result the cancelled run's checks no longer count,
  under whatever name they carry. With nothing to replace it the drive exits
  `4`. A cancelled check never reads as passing, so a required check a held run
  cancelled still blocks.
- A `drive-pr` CI-repair pass is told which runs failed, in
  `DRIVE_PR_ROUND_FAILED_RUNS`, and re-runs those rather than a cancelled sibling
  on the same head. A run created under the CI hold's label is left out, since a
  re-run replays that event.
