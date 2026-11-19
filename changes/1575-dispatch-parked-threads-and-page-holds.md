---
release: patch
---

### Fixed

- `jig dispatch` no longer reads every parked review thread on every tick.
  Each tick now asks whether the pull request's review comments changed, a
  request that costs no rate limit while they have not, and reads a parked
  thread again when they did, or once its last reading is an hour old. A
  reading is reused only when it was taken at least 2 minutes after the
  comments last changed and holds every comment the listing shows for its
  thread, so the first ticks after a change, and after a pull request is first
  seen, still read its threads. An answer on a thread is still seen by the
  next tick.
- A page size shrunk after the forge ran out of time now recovers after 5
  minutes rather than an hour. Each further shrink within two hours doubles
  that wait, up to the hour, so a forge that keeps timing out still gets small
  pages.
