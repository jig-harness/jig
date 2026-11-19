---
release: patch
---

### Fixed

- A drive that a dispatched session arms in an Orca terminal tab now knows it was dispatched. The tab's command carries the session's launch as `JIG_DISPATCHED_FROM`, and the driver hands it to every pass, so a repository's gate command can treat those passes as dispatched (Jig's own does, under `gates.dispatch_fast`). Before, the tab's login shell lost `JIG_LAUNCH`, and those passes ran the full gates. What a pass reports as its launch in round reports, closing reports and `jig send`'s refusals is still `JIG_LAUNCH`. A drive armed outside any dispatched session carries no launch record and keeps the full gates.
