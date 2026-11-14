---
release: patch
---

### Fixed

- `jig dispatch` opening an Orca workspace on this machine now runs the
  repository's create hook under the same supervisor the workspace tools use:
  the hook leads a process group of its own, and a hook that fails or
  outlives its limit is ended with every process it started before its claim
  is given back. Before, a failed hook's children (a dependency install, say)
  could keep changing the worktree while the next open ran the hook again.
  **Consumer action:** none.
