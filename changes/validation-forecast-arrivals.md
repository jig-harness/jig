---
release: patch
---

### Fixed

- The dispatcher's validation-capacity gauge (`load.validation`) no longer
  counts a run in flight ahead of a new pass when that run is expected to
  finish before the new pass reaches the test lock. Each pickup or drive in
  flight that has yet to make its first run is placed at its launch plus its
  kind's measured time to validation, its remaining runs follow one another,
  and the lock's requests are served in arrival order. Passes launched
  together queue behind each other, and a run reaching the lock between the
  new pass's own runs counts against its later ones. A pass with no estimate
  (its kind's time to validation is still the default, its launch time does
  not read, that time has passed, or it has made a run already) and the runs
  admitted in the same tick are counted ahead. The gauge's reason, in the
  receipt and on the dashboard, names the runs served before the pass
  reaches the lock and the runs arriving after its first run that a later
  one waits behind, beside the runs ahead, which are whole runs still holding
  or waiting when the pass arrives, and its minutes are the pass's wait.
