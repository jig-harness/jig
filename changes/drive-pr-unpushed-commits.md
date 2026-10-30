---
release: patch
---

### Fixed

- `drive-pr`: work nobody pushed no longer stalls a drive in a `HEAD_LAG`
  wait that cannot end, or ends it over a dirty tree. When a pass ended its
  turn after committing without pushing and still exited `0`, or a drive
  was armed over local commits, the next status check read local HEAD ahead
  of the pull request's head as GitHub lagging behind a push and polled for
  its whole timeout (30 minutes by default) before stopping; meanwhile
  replies promised fixes that were not on the pull request and CI stayed on
  the old head. A pass that ended after editing without committing could let
  the drive converge and then stop with exit `12`. The driver now measures
  the tree afresh before every round's status check, the commits local HEAD
  has on top of the head branch's remote ref and the edits the last pass left
  uncommitted, compared by content (a symbolic link by its target), inside
  submodules and untracked nested repositories too (a commit in one
  included), however large an untracked file, and without a stalled
  filesystem holding up the driver (a tree dirty at arm still stops at
  convergence), hands
  the round out over that head as it already did after a pass killed at its
  deadline, and tells the round's pass to push them (a notice opening
  `UNPUSHED COMMITS`, or `UNCOMMITTED EDITS` for edits alone). Commits that
  do not build on that ref, which no round could push, stop the drive at once
  with exit `1`, naming them; the attach's refusal of a diverged tree at arm
  time names them too. A head that was pushed and that GitHub has not caught
  up with is still waited for. A failed pass still stops the drive, to be
  re-armed; its stop now lists the paths it
  left uncommitted, untracked files and modified submodules included, and the
  commits it left unpushed.
- `drive-pr`: the drive's filesystem probes (the tree measurement above, the
  check for an unfinished merge or rebase, and the status check's comparison
  of the driven tree with the tree it measures) run outside the repository
  they measure and without its `.env` files, so a consumer repository's own
  Bun configuration (a `bunfig.toml` preload, say) can no longer fail them or
  write into their output.
