---
release: patch
---

### Fixed

- `do-item` releases a clean, pushed implementer's isolated worktree before arming the drive, so its branch is available to the pull request's workspace. Dirty trees, unpushed commits and unfinished git operations stay attached and are reported with inspection and release commands.
