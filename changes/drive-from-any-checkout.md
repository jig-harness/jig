---
release: minor
---

A pull request can be driven from any working tree of its clone, from the clone's primary checkout, or from a session in another repository.

### Added

- `drive-pr` attaches the pull request to the working tree once it holds the tree's lock and before it takes the pull request's (`plugin/skills/drive-pr/scripts/attach-pr.ts`, also runnable alone): it checks that `origin` is the pull request's repository, fetches the head branch and checks it out when no other working tree of the clone holds it, or checks out the head commit detached when one does, and never creates a second branch with a suffixed name. It refuses, naming what is in the way, a tree with uncommitted changes or an unfinished git operation, a tree holding the branch that is dirty or has commits the head lacks, a detached head with commits no branch or remote holds, the clone's primary checkout on another branch, and a pull request from a fork, and it moves no tree a live driver or an interactive session holds. `DRIVE_PR_ATTACH=off` drives the tree as it stands. See [which working tree drives it](../plugin/skills/drive-pr/README.md#which-working-tree-drives-it).
- A detached tree records its pull request, head branch and attached commit in its own git directory, read while its head descends from that commit and the branch is on the remote; on a detached head every script that reads the branch name, counts unpushed commits or resolves the pull request from the current branch reads that record, so base sync, the intent-chain pin, the handoff's issue key, the round's base, `drives.ts --doctor`'s leftover check, `resolve-conflicts`' side labels, `resolve-review-comments`' thread and annotation listings and `fix-ci`'s log parser work in a detached tree. The drive state keeps a copy as `drivenBranch` for the handoff file.
- `/jig:drive-pr <PR>` from the clone's primary checkout arms the drive in the tree that holds the pull request, or creates one with git's `worktree add --detach` under the first root `gc.worktree_roots` names; resource collection's `worktrees` kind reads a detached tree's record to report it once its pull request merges or closes.
- `/jig:drive-pr owner/name#N` or a pull request URL arms the drive of a pull request in another repository, in the clone the new user-file field `clones` maps it to, checking its human checkpoint against that repository's tracker, or prints the command to run in a checkout of that repository when none is mapped ([`clones`](../plugin/CONFIGURATION.md#clones-user-file-only)).

### Changed

- `do-item` never creates a branch for an item whose pull request is already open: the branch is the pull request's head, attached with `attach-pr.ts`.
- The recovery advice after a stopped pass counts unpushed commits against `origin/<head-branch>` instead of `@{u}`, which a detached tree does not have.
