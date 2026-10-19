---
release: patch
---

### Fixed

- `drive-pr` and `do-item` retry Windows sharing violations during atomic state writes and lock moves, preserve directory lock fences on Windows, and identify worktrees by their canonical filesystem paths. Pickup records retain their no-symlink protection when Windows lacks Unix open flags, and unsupported state volumes report how to relocate `$DRIVE_PR_STATE_DIR`.
- Existing drives must finish held work and stop before the worktree identity upgrade. The `drive-pr` README documents clearing old leases with the old plugin before upgrading participants together.
