---
release: patch
---

### Fixed

- `drive-pr`: one failed forge read in the cancelled-run recovery (the head's
  check runs, its workflow runs, or the pull request and its CI hold) no
  longer ends the drive with exit `1`. A timeout, a server error or a lost
  connection is read once more, and the recovery goes on when that answers.
  A read that still fails, or meets a rate limit, stops the drive with
  `NOT_SETTLED` (exit `4`), which `jig dispatch` re-arms, and the drive's log
  names the read and its failure class. When that read was the check just
  before a re-run, the head's one automatic re-run is given back, so the
  re-armed drive requests it instead of parking on a re-run that never left.
  A failure waiting cannot clear (a refused credential, an answer that does
  not read) is not retried and is not re-armed.
- GitHub calls: `gh`'s `error connecting to <host>` message now counts as no
  answer from the forge (`unreachable`), which waiting can clear, instead of a
  request the forge refused.
