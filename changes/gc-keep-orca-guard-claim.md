---
release: patch
---

### Fixed

- `jig gc` no longer lets Orca launch an agent into a worktree whose removal
  may still be under way. When `orca worktree rm` times out, exits with an
  error, or prints something gc cannot read, gc now keeps its claim on the
  worktree, so Jig's plugin for Orca keeps refusing launches there. The next
  run checks again that the worktree is idle and calls `orca worktree rm`
  once more; the claim is released when that call answers, or when the
  worktree is gone from Orca's list and from the disk. The receipt says when
  a claim is kept and why
  ([the launch guard record](../plugin/gc/README.md#the-launch-guard-record)).
  **Consumer action:** none.
