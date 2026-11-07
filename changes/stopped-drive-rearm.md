---
release: minor
---

### Added

- `jig send drive@<owner>/<name>#<PR> rearm` requests another attempt for a
  stopped drive on an admitted account in its existing worktree. Running
  drives and stops recorded by a person are refused.

### Fixed

- The dispatcher gives a drive stopped on an unclean worktree (exit `12`)
  one recovery pass per head in the same tree, with instructions to settle
  its edits. A repeated exit `12` waits for a person and names the `rearm`
  command.
