---
release: patch
---

### Fixed

- `jig gc`'s `worktrees` kind no longer keeps every worktree `unverified` on a machine where `lsof` warns about mounts it cannot read, such as a desktop's document portal or a container's mounts: a warning about a mount that neither holds the worktree nor lies inside it is set aside, while one about the worktree's own mount still keeps it unverified.
