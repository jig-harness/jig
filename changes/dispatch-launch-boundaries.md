---
release: patch
---

### Fixed

- Dispatcher ticks remove Electron's Node mode and crash reporter environment
  before starting child programs, so an Electron host does not change how those
  programs run.
- Before opening a drive workspace, the dispatcher verifies the pull request's
  head repository and commit, refusing mismatched remotes and stale checkouts
  before repository setup hooks run. Merged follow-ups can still recreate a
  deleted branch from the base.
- Dispatcher-launched drives preserve the tick's configuration layers across
  fresh terminal shells, including a custom or relative `JIG_HOME`.
