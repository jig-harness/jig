---
release: minor
---

### Added

- The dispatcher runs follow-ups in a lane of their own. A follow-up opens
  its workspace from the machine file's new `followup_opens_per_tick` (2 by
  default), never from the drive launches' `opens_per_tick` or the notices
  workspace's reserved open, and no more than `followup_concurrency` (2)
  follow-up passes run on the host at once; both are documented in
  CONFIGURATION.md. The lane's opens count in the tick's budget, so the
  tick's deadline grows with them, and a value whose opens take that budget
  past the longest a timer holds (about 24.86 days) is refused, naming the
  field. Follow-ups still share the accounts' slots. A waiting follow-up's
  receipt entry and dashboard queue entry say what it waits on (`waitsOn`):
  the lane's budget, the lane's cap or the accounts. A recorded stuck launch
  (notified to a person) stops counting toward `followup_concurrency` only
  while the runtime shows no session running on its target; one whose
  session runs, or cannot be read, keeps its place.
- **The installed tick deadline grows.** The default lane adds two workspace
  opens to the tick's budget, so `jig upgrade` lengthens the installed tick's
  deadline from its six-hour minimum to about 8h50m at the default
  `workspace_timeout` (six opens of 87 minutes and eight runtime calls). No
  setting needs to change.
- A follow-up whose pass stops on a routine question is run again once with
  the question's standing answer instead of waiting for a person. The routine
  classes are a fixed list in the dispatcher (today `local-leftover`: a local
  branch or worktree the pass may not delete without asking, answered keep
  it, list it, finish the rest and record done); the pass tags its own
  question (`Question: [local-leftover] …`). A follow-up that failed before
  this release is run again once, with every class's standing answer, while
  its launch record is still on the host (`receipts_days`); one whose record
  is gone waits for a person. An untagged question, a question the outcome
  record cannot read back, or a failure of the run again waits for a person
  as before, and a follow-up is never run again more than once by a death
  and a routine question together, within the pull request's recovery
  budget. Unlike a death's run again, which waits at most six hours, a
  routine run again has no age limit.
