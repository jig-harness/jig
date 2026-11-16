---
release: patch
---

### Fixed

- The drive-pr README now says plainly how forge send pacing works: processes
  that send with the same GitHub credential key start their calls at least
  200 milliseconds apart, and processes with different keys do not wait on
  one another.
