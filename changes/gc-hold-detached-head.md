---
release: patch
---

### Fixed

- `jig gc` no longer loses a commit made on a detached agent tool worktree in
  the moment between its last check of the tree and `git worktree remove`.
  It now holds the tree's `HEAD.lock` from just before that check until the
  removal, so a commit, checkout or reset in the tree then fails with git's
  own "cannot lock ref" error instead of moving the head, and staged work
  makes git keep the tree. A detached tree in a repository that keeps its
  refs in reftable is kept rather than collected, since that lock holds
  nothing there ([plugin/gc/README.md](../plugin/gc/README.md#worktrees-an-agent-tool-makes)).
