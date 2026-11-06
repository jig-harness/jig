---
release: minor
---

### Added

- Each `jig dispatch` receipt records how many milliseconds each phase took:
  every phase of each repository's turn (`open`, `tracker`, `forge`,
  `claims`, `runtime`, `observe`, `plan`, `log`, `apply`, `labels`,
  `shared`) and the tick's own start, repositories and close. The tick's
  text output prints them one line per repository, and `jig dispatch
  receipts` prints how long each tick took and how many defects it recorded.
  A receipt written by an earlier version reads as before.

### Fixed

- A bug or an unexpected write failure in one repository's turn no longer
  ends the whole tick. That repository's report says which phase it stopped
  in and what was thrown there, and keeps what its earlier phases did. The
  error's stack goes to the tick's error output, which the journal keeps.
  The other repositories are read, planned and acted on, and the tick writes
  its receipt and exits 1. A failure in the tick's closing steps still writes
  the receipt, marked incomplete.
- The tick lock records its holder's start time and the host's boot beside
  its process id (`tick.lock.holder`), so a lock left by a tick that died is
  taken over even when its process id was reused after a restart or by
  another process. A tick of an earlier version still reads the lock, and a
  lock it took is judged by its process id, as before.
