---
release: patch
---

### Fixed

- `drive-pr`'s foreground wait (`foreground-wait.ts launch`) now returns only
  once its runner has started the command, or settled without starting it.
  It used to return while the runner was still starting up, so a
  cancellation of the pass's recorded runners that began right after the
  launch could end the runner just before it started the command, which then
  ran on with nothing supervising it. On Windows a drive cancels a pass's
  runners that way when the pass ends or is stopped; on other systems the
  stop signals the pass's process group, which the command is in.
