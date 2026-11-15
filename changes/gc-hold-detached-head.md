---
release: patch
---

### Fixed

- `jig gc` no longer loses a commit made on a detached agent tool worktree in
  the moment between its last check of the tree and `git worktree remove`.
  It now holds the tree's `HEAD.lock` from just before that check until the
  removal, so a commit, checkout, switch or reset in the tree then fails
  with git's own "cannot lock ref" error instead of moving the head. A lock
  a stopped run leaves behind names `jig gc`. In a repository that keeps its
  refs in reftable, where that lock holds nothing, every tree is kept
  before its remove hook runs
  ([plugin/gc/README.md](../plugin/gc/README.md#worktrees-an-agent-tool-makes)).
