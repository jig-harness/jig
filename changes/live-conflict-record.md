---
release: minor
---

`resolve-conflicts` now keeps a record of the conflicts it resolves.

### Added

- `events.ts` in `resolve-conflicts` appends one `merge_conflict` event for
  each conflicted path to `$(git rev-parse --git-common-dir)/jig/conflict-events.jsonl`
  when a merge, rebase, cherry-pick or revert concludes: the path, why it
  conflicted, the decision and reason, how long the resolution took, and
  whether a `drive-pr` conflict-resolve round started it. It covers the
  rebases, cherry-picks and reverts that the merge-history report cannot
  replay, and the file is shared by every worktree of the clone and never
  committed. The skill's conclude step runs it, and mapping the next stop of a
  rebase records the earlier stop first.
- The `Conflicts resolved:` section of a commit message names each path's
  cause (`[cause: append]`) after its decision.
