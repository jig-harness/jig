---
release: patch
---

### Fixed

- The mechanism map's entry for `jig gc` said every worktree outside Orca is
  only reported. It now says that the worktrees an agent tool makes under the
  clone's `.claude/worktrees/` are collected with git, and links the
  collector's section on them.
