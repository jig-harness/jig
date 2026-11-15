---
release: patch
---

### Fixed

- A drive no longer stops on its own working files in a repository that
  does not ignore `.context/`. The handoff, mailbox and other files the
  drive writes there used to show up as untracked changes, and the attach,
  the push and the convergence check refused the tree until a person added
  an exclude by hand. `drive.ts` now adds `.context/` to the clone's local
  exclude file (`info/exclude`, never committed) when the repository's
  ignore rules do not cover it, once, keeping the lines already there. A
  repository that already ignores `.context/` is left as it is, and every
  file outside `.context/` is judged as before.
