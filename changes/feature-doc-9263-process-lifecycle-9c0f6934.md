---
release: patch
---

### Fixed

- Drive cancellation, foreground command deadlines, and process diagnostics use native Windows process snapshots. `drives.ts --stop` requests an orderly shutdown on Windows, and claims distinguish operating systems sharing a worktree.
