---
release: patch
---

### Fixed

- `jig gc` now holds a worktree Orca manages to the commit and branch its final proof saw, and holds the worktree's `HEAD.lock` from the last comparison through `orca worktree rm`. A commit made on a detached head after the proof keeps the worktree, and one tried while Orca removes it fails with git's "cannot lock ref" error; before, either was lost with the worktree. A repository that keeps its refs in reftable now keeps its Orca worktrees, as it already kept an agent tool's. [plugin/gc/README.md](../plugin/gc/README.md#worktrees-orca-manages) says what the collector guarantees.
