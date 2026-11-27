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
  still in the pass's process group when the pass exits, stops it, and starts
  the pass again in the same tree with a notice saying what happened and what
  the tree holds. These restarts share the `drive.pass_deadline_retries`
  budget with restarts after a pass deadline, and the drive's ledger records
  them as `restart` events with the cause `background-pending`. The
  environment check needs `/proc` (Linux). On other POSIX hosts the driver
  finds only processes still in the pass's process group, and on Windows it
  finds none.
