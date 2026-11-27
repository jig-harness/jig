---
release: patch
---

### Fixed

- On the process runtime, a pickup whose worktree create hook left a daemon
  running in the new worktree (a build tool's, started by a dependency
  install) was held in the tick that prepared it, as a workspace with a
  terminal whose agent the runtime cannot report, and launched only a tick
  later. A worktree hook now runs with `JIG_HOOK_WORKTREE` naming its
  worktree, and the runtime leaves the processes whose environment carries
  it for that worktree out of the count, so the pickup launches in the same
  tick. Any other process working in the worktree, a person's shell or an
  agent started by hand, still holds the pickup; on a host without `/proc`
  the count is unchanged. Why this way and not another is in
  [the process runtime's design](../design/dispatched-sessions.md#a-worktree-hooks-leftovers).
