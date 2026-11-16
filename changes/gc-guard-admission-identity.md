---
release: patch
---

### Fixed

- `jig gc`'s launch guard admission now names the repository whose
  collection took it and the worktree incarnation it was taken on (version 2
  of the `orca-guard-admission` record; version 1 still reads). Another
  repository that declares a common worktree root no longer releases a claim
  from a list of Orca's worktrees that cannot hold the worktree, and a
  worktree made again at a claimed path no longer inherits the old claim's
  block on agent launches: each run lists such a claim with
  `details.claim: superseded` and collecting it releases the claim. A gone
  claim written by an earlier release, which names no repository, is
  reported for a person to inspect instead of being released.
