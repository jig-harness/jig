---
release: minor
---

### Added

- `jig gc`'s worktrees kind tells a worktree Orca manages from a plain one
  and collects it through Orca. With `gc.orca.command` in the machine's
  `~/.jig/jig.yaml` (an absolute path, since the scheduled run is not in an
  Orca terminal), the inventory reads `orca worktree list --json` for the
  repository and marks each checkout `runtime: orca` or `none`. An Orca
  checkout's idle proof also reads Orca's registry (`orca worktree ps
  --json`): an agent Orca reports working or waiting in it keeps it, and a
  registry that cannot be read refuses collection. An idle one is collected
  the way the Orca workspace tool removes one: the repository's remove hook
  inside it, its reflection findings parked, then `orca worktree rm`, so its
  card, terminals and agent records go with it; the receipt names the hook
  and the park. A plain worktree stays report-only.
