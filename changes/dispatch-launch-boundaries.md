---
release: patch
---

### Fixed

- Dispatcher ticks remove Electron's Node mode and crash reporter environment
  before starting child programs, so an Electron host does not change how those
  programs run.
