---
release: patch
---

### Fixed

- `jig dispatch` no longer reads every parked review thread on every tick.
  Each tick now asks whether the pull request's review comments changed, a
  request that costs no rate limit while they have not, and reads a parked
  thread again only when they did, or once its last reading is an hour old.
  An answer on a thread is still seen by the next tick.
- A page size shrunk after the forge ran out of time now recovers after 5
  minutes rather than an hour. Each further shrink within two hours doubles
  that wait, up to the hour, so a forge that keeps timing out still gets small
  pages.
