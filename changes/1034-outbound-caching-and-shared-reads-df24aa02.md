---
release: patch
---

### Changed

- Tracker and forge reads share the outbound library’s caching, duplicate-read
  grouping and bounded batches. Quiet ticks reuse unchanged assignment answers,
  while failed reads are retried on the next tick. The change probe compares
  check-state totals instead of downloading each check. **Consumer action:** none.

### Fixed

- Review-finding deferrals use the tracker adapter’s governed transport, and
  issue children are read in bounded pages. Forge cost reports identify REST
  routes even when command flags precede the route. **Consumer action:** none.
