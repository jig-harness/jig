---
release: patch
---

### Fixed

- Drive cancellation, foreground command deadlines, and process diagnostics use native Windows process snapshots. `drives.ts --stop` requests an orderly shutdown on Windows, and claims distinguish operating systems sharing a worktree.
- Foreground waits report failure when the process tree cannot be confirmed stopped, preserving the command's exit status and preventing a new launch from discarding unresolved work.
- Foreground supervisors establish ownership before executing commands, and cooperative stops preserve generation-bound completion proof through registry cleanup.
