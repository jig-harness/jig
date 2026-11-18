---
release: minor
---

### Added

- A shared workspace opener gives Orca and plain git worktrees the same branch and create-hook rules. Process worktrees carry owner records under shared collection admission; `jig gc` finds their runs root and collects them only after their launches and recorded processes have ended, preserving every existing Git and local-content check.
