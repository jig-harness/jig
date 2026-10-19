---
release: minor
---

### Added

- Conflict resolution accepts repository obligations over the whole resolved
  diff, including automatically merged files and hunks, with optional
  validation commands. Each command runs only while every tracked file on
  disk matches the staged tree, including submodules and files Git is told
  not to compare, and a command that changes either stops the commands after
  it and invalidates the run.

### Changed

- **Breaking:** Conflict resolution requires Git 2.40 or newer to reconstruct
  the automatic merge result. Upgrade Git before using the skill. Picking or
  reverting a merge commit with `-m` requires manual resolution and validation
  because Git does not reliably retain the selected parent.

### Fixed

- Conflict resolution rejects staged paths outside the operation and manual
  changes without recorded decisions, so unrelated staged work cannot ride
  into its commit.
