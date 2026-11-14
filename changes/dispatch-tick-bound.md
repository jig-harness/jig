---
release: minor
---

### Added

- A dispatcher tick its launcher bounds now keeps every read of its observe
  phase to one bound: the launcher's deadline less the time its receipt
  needs. The tracker's assigner, mover, claimed-item and claim-marker reads
  and the session runtime's listings are given the bound's signal where
  their transport takes one, and held to it either way. A forge listing or
  query the bound ended before is not started, a paged forge query asks no
  page after the bound ends, and a comment listing gets no more time than
  the bound has left. A read the bound cut short is a failed read of class
  `unreachable`: a repository refused, a tracker, forge or runtime record
  not ok, or an item unplaced with "the tick's deadline passed before …".
  The tick still writes its receipt and lets its locks go, and the failure
  ledger tells a person when it keeps happening. A tick no launcher bounds,
  such as one run by hand without a machine file, reads as before. The
  tracker port's `assignedBy` and `stateChangedBy` and the session
  runtime's `sessions` take an optional `AbortSignal` on the GitHub, Jira
  and Linear adapters and on Orca. **Consumer action:** none.
