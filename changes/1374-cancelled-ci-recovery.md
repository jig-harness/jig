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
- drive-pr: a cancelled check is no longer passed over when a later run of
  the same workflow reported it only under its matrix's expanded names
  (`tests (1/2)` for `tests`) and any of them has no result (skipped, say).
  Such a run has not run the job, so the cancelled check stays unknown and the cancelled-run
  recovery re-runs it or parks; a later run whose every leg ran to a result
  still replaces it. **Consumer action:** none.
