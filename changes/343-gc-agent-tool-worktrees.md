---
release: minor
---

### Added

- `jig gc`'s `worktrees` kind now finds the worktrees Claude Code's agent
  tool makes for isolated subagents under the clone's `.claude/worktrees/`,
  without a `gc.worktree_roots` entry, and collects them with
  `git worktree remove` once they are clean, idle past the guard, held by no
  process and covered by a merged or closed pull request (or hold no commit
  the base lacks). A tree it keeps on a branch names that branch and the
  `git -C <tree> switch --detach` command that releases it. Before this
  release those trees were never reported. A confirmed `worktrees` kind now
  covers that directory without reinstalling, and scheduled runs remove the
  trees that qualify on the collection day or under disk pressure: run
  `jig gc --kind worktrees` to see which those are.
