---
release: patch
---

### Fixed

- A dispatched follow-up whose release arm stays pending past
  `dispatch.followup_within` no longer goes to a person while the release it
  waits for is minutes away. The window starts again when a pass names a
  newer release than the one it started on (up to three windows after the
  first pending pass), and before the follow-up is raised the tick reads the
  release tags its arm names once more: when they all exist, it runs the
  follow-up again instead. An arm still pending at that read is raised once,
  naming it, as before.
