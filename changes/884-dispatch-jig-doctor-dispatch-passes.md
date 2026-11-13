---
release: minor
---

### Added

- `dispatch.stalled_scope` (`claimed` by default, or `assigned`) decides
  which of the factory identity's claimed items the stall watch reads as
  pickups.

### Fixed

- `jig doctor dispatch` no longer passes while every tick fails. A tick that
  a throw stops before its act phase, such as one whose state database is
  refused at the start, now writes a failed receipt, so `jig status` and
  `jig doctor` read that tick rather than an older successful one. The
  `dispatch:last-run` check names the latest tick's failure reason and, when
  more than one tick in a row failed, how many and since when.
- The stall watch no longer reads someone else's work as a stalled pickup.
  An item assigned to the factory identity in progress counts as a pickup
  only when a launch record of the host or a claim marker took it.
  `dispatch.stalled_scope: assigned` keeps the wider watch, for a repository
  whose identity nobody else uses. A double claim is still reported for any
  claimed item.
