---
release: patch
---

### Changed

- The `drive-pr` and `do-item` test suites now run on Windows in the nightly
  workflow, the `drive-pr` suite as its own sharded job and `do-item` inside
  the gate set. The tests that need work the skills do not have yet (finding
  and stopping a pass's processes without `ps` and POSIX signals, state and
  locks for Windows file systems, the skills under Git Bash) skip on Windows
  and name the piece of work that lifts each skip. Neither skill's behaviour
  changes.
