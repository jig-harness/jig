---
release: minor
---

### Added

- Shell-independent commands for pickup, pull request drives and their
  sibling skills, including PowerShell. File arguments replace shell pipes
  and redirections, and the review skill computes its file set and trusted
  policy snapshot in Bun.

### Fixed

- Recovery commands preserve paths containing shell punctuation without
  requiring a Bash shell. A repository gate checks skill instructions for
  shell-dependent commands.

### Changed

- **Breaking:** `fix-ci` setup commands run through Bun's native shell on
  every platform. Before upgrading, replace shell-specific setup syntax with
  a Bun script or commands that Bun's shell supports.
