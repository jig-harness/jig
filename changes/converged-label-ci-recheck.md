---
release: patch
---

### Fixed

- A drive that stops `CONVERGED` no longer leaves a pull request labelled
  `converged` while its own label write blocked CI. In a repository whose
  workflows run on label events, adding `converged` and removing `driving`
  starts runs on the head the drive just verified; those runs could cancel
  each other or fail a flaky test, and no drive was left to notice. The drive
  now watches that head's CI after the write, while it still holds the pull
  request: it re-runs a cancellation the write caused through the
  cancelled-run recovery, re-runs a failure in a run a label write started
  once, and when CI is still not green, or has not settled within
  `DRIVE_PR_CONVERGED_CI_MINUTES` (30 minutes by default, `0` turns the watch
  off), it parks `converged-ci` with the runs it saw, stops with
  `HITL_PARKED` and labels the pull request `parked`.
