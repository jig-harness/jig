---
release: minor
---

### Added

- Outbound calls now leave hourly cost totals per system, hashed credential,
  operation and caller in the shared budget database, retained for 7 days.
  `jig budget` reads spending by operation and caller with JSON output; tick
  reports show balances, this tick's spending and its costliest operations.
- A low-quota need names operations whose recent spending would empty a quota
  before refill, and clears when that projection recovers. Unknown costs and
  estimates are identified; an unavailable ledger never prevents a call.
