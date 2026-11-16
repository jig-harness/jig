---
release: patch
---

### Fixed

- The drive-pr README now says plainly how forge send pacing works:
  processes that send with the same GitHub credential key are admitted to send
  at least 200 milliseconds apart (a delayed send can still start closer to
  another), and processes with different keys do not wait on one another.
