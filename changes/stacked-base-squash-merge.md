---
release: minor
---

### Added

- `/jig:resolve-conflicts` starts a base merge with its new
  `start-merge.ts`. When the pull request was stacked on another branch that
  has since been squash- or rebase-merged into its base, the merge takes the
  point where the branch left that earlier base as its merge base. Only the
  pull request's own changes can then conflict, and the earlier branch's
  changes no longer conflict with their own squashed copy, which used to
  spend a drive's conflict-resolve round. The merge commit records the
  earlier branch and the merge base, and `conflict-map.ts` maps the conflicts
  against that base. In every other case the merge is Git's own, as before.
