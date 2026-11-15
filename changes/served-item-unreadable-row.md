---
release: patch
---

### Fixed

- `jig dispatch` no longer fails a repository's whole tracker record when one
  served item cannot be placed though no read of it failed: an item whose
  history holds no assignment of the served person, an item or child the
  tracker read cut short, or an epic whose description is missing. The item
  is reported as its own unplaced row with its reason, the record stays ok,
  and the claims stay unknown, so no ended pickup is released on that
  reading. A served queue whose listing failed, and an item whose read
  failed, still fail the record with the failure's class.
  **Consumer action:** none.
