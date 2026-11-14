---
release: minor
---

### Added

- A dispatcher tick its launcher bounds now keeps every read of its observe
  phase to one bound: the launcher's deadline less the time its receipt
  needs. The tracker's assigner, mover and claimed-item reads, the session
  runtime's listings and the forge's pull request, comment and merge
  listings are given the bound's signal where their transport takes one,
  and held to it either way. A read the bound ended before it began is not
  started: the tick reports it as a failed read (a repository refused, a
  tracker, forge or runtime record not ok, an item unplaced with "the tick's
  deadline passed before …"), still writes its receipt and lets its locks
  go, and the next tick reads the rest. A tick no launcher bounds, such as
  one run by hand without a machine file, reads as before. The tracker
  port's `assignedBy` and `stateChangedBy` and the session runtime's
  `sessions` take an optional `AbortSignal` on the GitHub, Jira and Linear
  adapters and on Orca. **Consumer action:** none.
