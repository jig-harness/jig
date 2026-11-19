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
  footprint unknown`) until its footprint is recorded or it ends. Where the
  catalog is configured but serialization cannot be decided in a run, no
  pickup is placed that run. A repository whose catalog marks no area
  `serialize: true` sees no change.
