---
release: patch
---

### Added

- **Orca as a workspace runtime.** The [workspace launcher](../tools/launcher/README.md)
  gains an `orca` provider: a tracker issue opens as an
  [Orca](https://www.onorca.dev) worktree, in Orca on this machine or on a
  paired Orca server, with the issue's branch named as the repository names
  it, the repository's create hook run once, and the agent started with its
  first prompt once per issue. The [Orca workspace tool](../tools/orca/README.md)
  behind it also opens and removes such worktrees by hand, and says how to run
  Orca's headless server on a host.
- `reflect` records Orca as the session's wrapper when Orca started the
  harness (`ORCA_…` in the environment), as it does Herdr and Conductor.
