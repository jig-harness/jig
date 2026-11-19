---
release: minor
---

### Added

- **Serialized areas hold pickups.** The dispatcher no longer starts a
  pickup whose footprint reaches a serialized area of the change-area
  catalog while an open pull request, a pickup in flight or a pickup it
  plans ahead touches the area. The pickup is reported among the serialized
  holds as `held: serialized behind #N in <area>`, in the run's report and
  the dashboard's queue, and starts on the first run after that work ends.
  A footprint that is unknown cannot rule an area out, on either side: such
  a pickup waits while any serialized area is occupied (`, footprint
  unknown`), and such work occupies every serialized area (`, #N's
  footprint unknown`) until its footprint is recorded or it ends. Every open
  pull request counts, a draft or a quiet one included, so a stale pull
  request in a serialized area holds new work there until it is closed.

### Changed

- In a run where the configured catalog or the open pull requests do not
  read, including a run whose budget skips the catalog read, no pickup is
  started: each is reported as `whether it reaches a serialized area cannot
  be told this tick` and waits for the next run, as the drives already did.
  This holds whether or not the catalog marks an area `serialize: true`,
  since a run that did not read it cannot tell.
