---
release: patch
---

### Fixed

- A dispatcher tick no longer fails when a read it makes for one item meets
  a rate limit or gets no answer from the forge or the tracker. Those reads
  are a pull request's comments (its drive ledger, launch claims and
  follow-up markers), a parked drive's thread answers, a conflicting
  drive's base branch head, and a claimed item's claim markers. The item's
  row now carries the failed call's
  [failure class](../GLOSSARY.md), and the tick handles it as it already
  handles a repository's read: it exits 0 below `failures.notify_after`, and
  tells a person at once of a refused credential. A ledger or marker that
  does not parse still fails the tick. See
  [When an outside system refuses or does not answer](../plugin/CONFIGURATION.md#when-an-outside-system-refuses-or-does-not-answer).
  **Consumer action:** none.
