---
release: patch
---

### Fixed

- The tests of the plugin's conditional GitHub reads, of drive-pr's
  single-instance lock and of
  [M10](../modules/M10-environments-deploy/README.md)'s external
  preconditions deadline no longer fail on a slow or loaded machine. The
  deadline tests give a request a budget no stall can use up and wait for
  the deadline to pass when it must; the lock tests wait for a drive's pass to
  start for as long as native Windows needs; and the conditional-read tests
  start a throwaway child process first, because Bun's test runner can lose
  the events of the first child process a test file starts.
