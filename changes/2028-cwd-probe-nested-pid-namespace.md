---
release: patch
---

### Fixed

- The working-directory probe that dispatch, the idle-worktree checks and
  `jig gc` use no longer reports every worktree as unknowable while a
  container runs under the host user's uid: a process whose directory its
  owner cannot read is now accepted when it runs in a nested PID namespace
  (more than one pid on `NStgid:` in its `/proc/<pid>/status`), as one
  holding privileges its owner lacks already was. A process of the probe's
  own PID namespace whose directory cannot be read still makes the answer
  unknown.
