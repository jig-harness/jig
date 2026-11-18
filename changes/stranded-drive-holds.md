---
release: patch
---

### Fixed

- A stopped drive that a launch of unknown process still holds no longer reads as waiting on nothing. `jig ask` names the hold, why its process is unknown and how long it has held the drive, and `waitsOn: none` now means a holder whose process is alive or a running ledger inside its lease. Past 30 minutes the dispatcher raises a need for such a drive, and a person can clear this machine's launch record from it.
