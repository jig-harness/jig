---
release: patch
---

### Fixed

- `jig dispatch` no longer fails a repository's whole tracker record when one
  served item cannot be placed for a reason no failed call caused: an answer
  whose history holds no assignment of the served person, an item or child
  the tracker read cut short, or an epic whose description is missing. The
  item is reported as its own unplaced row with its reason, the record stays
  ok, and the claims below it stay unknown, so no ended pickup is released
  on that queue. A served queue whose listing failed, and an item read a
  failed call stopped, still fail the record with that call's failure class.
  **Consumer action:** none.
