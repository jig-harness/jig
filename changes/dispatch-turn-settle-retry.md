---
release: patch
---

### Fixed

- `jig dispatch` keeps a follow-up's launch record until its outcome is
  written: a failed write at the start of a tick is retried at its close, and
  while it still fails those records are not pruned. The failure stays on the
  receipt as its defect, so the receipt is not completed.
