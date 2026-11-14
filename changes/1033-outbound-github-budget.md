---
release: minor
---

### Added

- GitHub's limits join the machine's shared budget record. Every `gh` call
  Jig makes is admitted against the forge credential's record and tells it
  what its answer said: a `gh api` call reads the rate-limit headers of its
  answer (the headers are taken off the output its caller reads), a
  GraphQL answer that selects `rateLimit` gives the GraphQL balance, and
  the `rate_limit` endpoint gives every limit. A primary or secondary
  refusal seen by one process stops every process on the machine: a spent
  primary limit until its reset, a secondary limit until its
  `retry-after`, else for a minute, doubled for each refusal in a row up
  to fifteen; nothing is sent before that. The dispatcher's tick keeps to its
  share of GitHub's core, GraphQL and search windows as it does of a
  tracker's. The tick reads the forge's budget, and `load.forge_floor`'s
  gauge, from the record, asking `rate_limit` only when no answer reported
  the core window in the last minute, and its `outbound github` report line
  names the core and GraphQL balances
  ([configuration reference](../plugin/CONFIGURATION.md)).
- `JIG_FORGE_BUDGET=off` leaves the forge's calls out of the budget record.

### Changed

- The machine file's `tracker_share` is now `outbound_share`, one setting
  for every system's windows. `tracker_share` still reads as its older
  name; a file that names both is refused. Keep `tracker_share` until
  every Jig copy on the host reads the new name: an older release refuses a
  machine file that names `outbound_share`.
