---
release: patch
---

### Fixed

- A fixture registry over its limit no longer stops the scheduled `jig gc` run
  before any kind runs. It fails the scratch kind alone: the receipt marks
  `scratch` as `failed` (every other kind as `run`), the run's exit and the
  dashboard's state-storage need name the scratch kind, and the worktrees and
  the other kinds still collect on the collecting run, worktrees first.
