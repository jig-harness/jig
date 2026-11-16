---
release: patch
---

### Fixed

- drive-pr: answering the `cancelled-ci` park with "Re-run safely" (or
  approving it) now does what the option says. Once the head's automatic
  re-run is spent, the re-arm that consumes the answer grants that head one
  more re-run: the drive repeats the head, CI-hold and event checks, requests
  the re-run and waits for its replacement, instead of parking the same
  question again within a minute. A park after a granted re-run says that
  re-run was spent. **Consumer action:** none.
