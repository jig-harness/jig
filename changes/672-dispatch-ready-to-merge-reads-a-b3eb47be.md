---
release: patch
---

### Fixed

- Ready to merge, the merge-ready announcement and `jig ask` use the latest
  ordinary check run by start time, then completion time. Superseded cancelled,
  failed or pending runs no longer hide a successful retry; a latest failed or
  cancelled required check still blocks merging and names the check.
