---
release: minor
---

### Added

- The dispatch dashboard's History view opens with **How the ticks ran**:
  one compact row per recent tick, the newest first, with how long it took,
  its own phases as a bar scaled to the longest retained tick, the slowest
  single phase and the repository it was in, the forge's rate budget it
  read, and a chip for a tick with a defect or one that ended with a failure.
  Low-budget and busy-repository chips require a tick producer that records
  those signals; the current producer does not. Each row opens to the time of
  every phase and every repository. The line carries the last 48 ticks,
  and a tick that reads only some repositories, such as a wake-up, adds
  its row without replacing the rest of the line. A tick whose closing steps
  fail also adds its health while preserving the previous snapshot; failed
  history reads are reported on the receipt.
