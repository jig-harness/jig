---
release: patch
---

### Fixed

- `drive-pr`: commits nobody pushed no longer stall a drive in a `HEAD_LAG`
  wait that cannot end. When a pass ended its turn after committing without
  pushing, whatever it exited with, or a drive was armed over local commits,
  the next status check read local HEAD ahead of the pull request's head as
  GitHub lagging behind a push and polled for its whole timeout (30 minutes
  by default) before stopping; meanwhile replies promised fixes that were not
  on the pull request and CI stayed on the old head. The driver now counts,
  before every round's status check, the commits local HEAD has on top of the
  head branch's remote ref, hands the round out over that head as it already
  did after a pass killed at its deadline, and tells the round's pass to push
  them (a notice opening `UNPUSHED COMMITS`). Commits that do not build on
  that ref, which no round could push, stop the drive at once with exit `1`,
  naming them. A head that was pushed and that GitHub has not caught up with
  is still waited for. A failed pass's stop now lists the paths it left
  uncommitted and the commits it left unpushed.
