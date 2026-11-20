---
release: patch
---

### Fixed

- The dispatcher's validation-capacity gauge (`load.validation`) no longer
  holds every pickup and drive on an idle test lock. Its wait window is now
  the wait a pass's test stage gives the lock: `LOCK_TIMEOUT` from the
  environment a pass is launched with (for a process launch, retained only where
  `process.env_keep` names it; an Orca launch is given the dispatcher's `LOCK_TIMEOUT`, and its lock root (made absolute) and name, always), or the test stage's hour
  when it is unset, rather than the bare lock's one-minute default. A pass's
  own runs, made one after another, no longer count as waiting behind each
  other, so a pass always fits a lock with nothing ahead of it. The runs
  still to come from passes in flight still count ahead of a new pass. The
  gauge's reason, in the receipt and on the dashboard, names the wait window
  and where it came from, and says when a window shorter than one run
  admits a pass only while a slot is free for its first run. A `LOCK_TIMEOUT` the lock
  refuses holds the pass, with the reason, rather than counting as an hour. The same environment
  places the lock's holders and waiters. A refused `LOCK_TIMEOUT` takes
  precedence over the lock's reading: the pass is held with the reason, and
  the refusal shows in the gauge's fill.
