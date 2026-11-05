---
release: patch
---

### Fixed

- `drive-pr` no longer stops when the CI hold label (`ci.hold_label`) is on a
  pull request but the drive did not add it. That happened when an earlier
  run of the drive lost track of its own label, when a drive died and left
  the label behind, or when someone else added it. `ci-hold.ts ensure` used to
  refuse the push (`CI_HOLD_WAIT`) on every round until the drive stalled or
  parked, and `release` left the label on at convergence. The drive now
  adopts the label: it pushes under it and removes it at convergence, then
  waits for fresh full CI as before. A failed push does not remove an
  adopted label. The label only saves CI. To stop a drive, use
  `drives.ts`'s `--stop`, or put the dispatcher's `jig:hold` label on the
  pull request.
