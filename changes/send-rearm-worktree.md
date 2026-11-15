---
release: patch
---

### Fixed

- `jig send … rearm` finds an existing pull request worktree from the
  dispatched pickup's result or its checked-out head branch when no drive
  record names one. It refuses ambiguous or incomplete searches and explains
  where it looked when no tree is found.
