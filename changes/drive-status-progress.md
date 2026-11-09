---
release: patch
---

### Fixed

- A reply left on an open human review thread now counts as progress for the
  drive’s stall check.
- Head mismatches now distinguish an unpushed local head, delayed API data,
  and diverged history, with the action each needs.
