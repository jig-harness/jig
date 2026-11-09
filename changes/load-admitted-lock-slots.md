---
release: minor
---

### Changed

- The machine-wide resource lock (M12's `with-resource-lock.ts`, which
  `jig gc --collect` and Jig's own suite run under) now admits runs into
  slots by the machine's load instead of one run per machine. Slot 0 is the
  lock's own name, so an earlier version still excludes and queues with it;
  slots 1 and up are `<name>-slot-<n>`. A free slot 0 is taken at once; any
  other slot only while the predicted load (the one-minute load average plus
  one run's cost for each run started in the last minute) leaves room for one
  more run under the cores times a target, and the available memory stays
  above a floor. The first run is always admitted, and a reading of the host
  that fails admits, so the slot ceiling decides. On Windows, which keeps no
  load average, memory and the ceiling decide. New settings beside
  `LOCK_NAME` and `LOCK_TIMEOUT`: `LOCK_SLOTS` (the ceiling, default 64),
  `LOCK_STATIC_SLOTS=1` (a static count, default 8), `LOCK_TARGET_UTIL`
  (0.85), `LOCK_RUN_COST` (4) and `LOCK_MIN_MEM_GB` (8). A waiting run says
  what it waits on (every slot held, the load, the memory, an exclusive
  holder) and who holds the slots. **Breaking** for a lock that guards a
  resource only one user may have at a time (a fixed port, a shared
  database): set `LOCK_SLOTS=1` for it, which restores the single mutex
  exactly.
- `jig gc --collect` takes the heavy-run lock exclusively (the new
  `--exclusive`): it announces itself so no new heavy run starts, waits for
  every slot in a fixed order, and holds them all while it collects. It no
  longer runs beside heavy runs held in slots other than the first.

### Added

- `plugin/shared/host-load.ts`: one reading of the host's load, cores and
  available memory, and the rule that says whether one more run fits, for
  every Jig mechanism that asks.
