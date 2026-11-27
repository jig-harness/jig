---
release: minor
---

### Changed

- `/jig:drive-pr` restarts a pass that exits with a process it started still
  running in the background, instead of stopping the drive with
  [`WORKTREE_UNCLEAN`](../plugin/protocol/drive-exits.md) over fixes the pass
  never shipped. A headless pass has no next turn, so such a process (the
  gates run in the background, say) reports to nobody. The driver gives every
  pass a token in its environment, finds a live process still carrying it or
  still in the pass's process group when the pass exits, and stops it. The
  driver then starts the pass again in the same tree, with a notice saying
  what happened and what the tree holds, since the process may have been
  validation the pass never saw finish. A process that cannot be stopped, or
  a scan that cannot look or cannot inspect a process that began after the
  driver, ends the drive with `INDETERMINATE`, with its locks kept. Signals
  are bound to each process's creation identity, and only a program name is
  recorded, never its arguments. These restarts share the `drive.pass_deadline_retries`
  budget with restarts after a pass deadline, and the drive's ledger records
  them as `restart` events with the cause `background-pending`. The
  environment check needs `/proc` (Linux). On other POSIX hosts the driver
  finds only processes still in the pass's process group, and on Windows it
  finds none.
