---
release: minor
---

### Added

- Select `runtime: process` in the machine dispatch file to run headless
  passes in Git worktrees without Orca on Linux and macOS. Jig launches each run through the
  host's service manager with an allowlisted environment and starts the
  pickup's first drive through the dispatcher.
