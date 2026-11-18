---
release: patch
---

### Changed

- The dispatcher takes a follow-up's tick outcomes, and the state label each one ends with, from the follow-up marker's table (`plugin/shared/records/followup-values.ts`) instead of restating them, and a test holds the state database's outcome check to that table: an outcome added there fails the type check and the test rather than the tick's write.

### Fixed

- A dispatcher tick whose deadline passed while it read a repository's pull requests no longer starts a base branch's head read, a driver presence check or the forge login read after it: the forge's reading is cut as `unreachable`, and the receipt and locks are settled as before.
