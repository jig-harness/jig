---
release: patch
---

### Fixed

- The dispatcher's validation-capacity gauge (`load.validation`) no longer
  counts a run in flight ahead of a new pass when that run is expected to
  finish before the new pass reaches the test lock. Each pickup or drive in
  flight is placed at its launch plus its kind's measured time to validation
  (now, once it has made a run), its remaining runs follow one another, and
  the lock's requests are served in arrival order. Passes launched together
  still queue behind each other. A run with no estimate (its kind's time to
  validation is still the default, or its launch time does not read) and the
  runs admitted in the same tick are counted ahead, as before. The gauge's
  reason, in the receipt and on the dashboard, names the runs served before
  the pass reaches the lock beside the runs ahead, and the runs ahead are
  now whole runs still holding or waiting when the pass arrives.
