---
release: patch
---

### Fixed

- The worktree collector now honors `GH_CALL_TIMEOUT` for pull request lookups (30 seconds by default) and reports when a lookup exceeds its deadline.
