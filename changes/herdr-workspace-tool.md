---
release: minor
---

### Added

- The [Herdr workspace tool](../tools/herdr/README.md) opens a branch as a
  Herdr worktree workspace, on the machine or on a remote host over SSH, with
  its agent started and its first prompt sent once per piece of work.
  Opening the same work again reattaches instead of creating a second
  worktree, and does not prompt an agent that already has the work. `remove`
  runs the repository's remove hook and parks the worktree's reflection
  findings before removing it.
- The launcher's `herdr` provider opens a tracker issue through that tool;
  set `provider: herdr` and `repos.<label>.herdr` in the launcher
  configuration ([launcher](../tools/launcher/README.md#providers)).
- [M12](../modules/M12-parallel-agent-ergonomics/mappings.md)'s worktree
  lifecycle runs in Herdr: a repository's `.config/worktree-hooks/create` runs
  in each new worktree, through a Herdr plugin, before an agent starts there,
  and `.config/worktree-hooks/remove` runs before a worktree is removed.

### Changed

- The launcher takes the branch the tracker suggests, read with the issue,
  when the launch itself names none; the prompt's branch hint and the
  provider both use it.
