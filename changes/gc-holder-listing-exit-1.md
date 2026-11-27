---
release: patch
---

### Fixed

- `jig gc` kept a worktree as `unverified` ("process holders could not be
  enumerated") when `lsof` listed a process in it but also warned about a
  mount it cannot read, a desktop's document portal or a container's mounts,
  because `lsof` then exits 1 and only an exit 0 counted as a holder. A
  listed process now reads as held, so the worktree is reported as in use, and
  one with no process listed over such warnings reads as not held. A warning
  about the worktree's own mount, a run that was killed or timed out, and an
  exit status that is no listing still leave the holders unknown, and the
  reason now names which.
