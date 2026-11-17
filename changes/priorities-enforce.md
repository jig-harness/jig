---
release: minor
---

### Added

- A host can let the declared priorities decide which pickups start first.
  With `priorities.enforce: true` in the machine file, the owner host's
  ranking places every pickup the tick plans to start, and each of a
  repository's starts the host's capacity allows goes to the next in its
  order: Urgent issues, then High bugs, then the weighted lanes by weight
  and the peripheral floor, then the unallocated work. Repositories still
  take their turns as before. Capacity stays the host's: the load factor, each
  account's free slots and walls and `max_per_account` still say how many
  start. A pickup that cannot start now passes its start to the next, and a
  lane out of rotation (weight 0, or a weights file that fails closed)
  starts nothing and its pickups are listed as quiet (`lane-paused`). The tick report names, for each start, the lane and
  objective it is charged to and why. The setting is off by default, and
  with it off nothing the dispatcher starts changes; a host turns it on
  after reading the ranking's reports
  ([CONFIGURATION.md § The machine's dispatch file](../plugin/CONFIGURATION.md#the-machines-dispatch-file)).
  **Consumer action:** none.

### Fixed

- The priorities shortlist ranks only the pickups the tick plans to start. A
  pickup a running session or launch record holds, or one waiting on a
  person, is listed as excluded with why, and no longer takes a place, and
  a lane's share, from the work that can start.
