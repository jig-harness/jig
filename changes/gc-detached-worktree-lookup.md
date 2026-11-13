---
release: patch
---

### Fixed

- `jig gc` no longer leaves a worktree with a detached HEAD `unverified`
  on every run when no drive recorded it, such as an implementer's tree
  that `do-item` released or a checkout the dispatcher detached. gc now asks
  the forge for the pull requests that hold the HEAD commit and runs the
  same proof a branched worktree gets: a tree whose commit a merged pull
  request holds and that holds nothing else goes on to the later checks,
  and one with commits no remote branch and no merged pull request's head
  holds is kept. A drive's tree record still decides while it describes the
  head. The reason names the pull request and whether the record or the
  forge named it ([plugin/gc/README.md § Detached
  worktrees](../plugin/gc/README.md#detached-worktrees)).
