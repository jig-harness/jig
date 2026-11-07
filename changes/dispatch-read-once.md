---
release: minor
---

### Changed

- `jig dispatch` reads less per tick. Each pull request's comments are
  listed once per tick and shared between its drive ledger, its park
  answers, its launch claims and its follow-up markers; the forge's login
  and rate limit and Orca's repository and workspace listings are read once
  per tick instead of once per repository. A merge whose `updatedAt` has
  not moved since its follow-up markers were last read is planned from the
  markers kept in the dispatcher's state database (a new `merge_reads`
  table) instead of being read again, as are the launch claims of a merge
  whose drive launches on this host all ended; every merge is read again at
  least once an hour. The reads just before a launch still go to the forge
  and the runtime. Each repository's report now carries the forge budget
  left after the whole tick.
