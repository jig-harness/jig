---
release: minor
---

### Fixed

- `jig gc` no longer keeps every finished worktree because of Jig's own
  working files and a tool's cache. The `worktrees` kind sets aside ignored
  content whose writer marked it disposable: a directory holding a
  `CACHEDIR.TAG` (cache directory tag), a directory whose own `.gitignore`
  ignores all of itself, `.context/scratch/`, and a drive's handoff. Any
  other ignored path still keeps the worktree, and the reason names it. The
  receipt lists each path set aside with its rule (`details.setAside`). See
  [the collector's rule](plugin/gc/README.md#ignored-content).

### Changed

- Jig's procedures write the files they never need again under
  `.context/scratch/`, and the drive's mailbox, foreground waits and intent
  chains tag their directories, so a finished worktree holds only marked
  working files.

### Added

- A one-time archive for worktrees made before marking began: right before
  removing such a worktree, `jig gc` copies its unmarked ignored content into
  `~/.local/state/jig/gc/archives/`, checks the copy, and names the archive
  in the receipt. Content larger than the new machine setting
  `gc.archive_max_bytes` (64 MiB by default, 0 to archive nothing), or a copy
  that fails, keeps the worktree. The `receipts` kind removes archives past
  `gc.receipts_days`.
