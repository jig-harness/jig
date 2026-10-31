---
release: patch
---

### Changed

- `drive-pr`: the stops for a usage limit (exit `16`, and exit `6` when the
  limit is met on the last round) and for a pass that found the pull request
  no longer open (exit `5`) now list what the pass left in the tree, as a
  failed pass's stop does: the uncommitted paths and the commits on top of the
  head branch's remote ref, or that there are none, instead of advice to run
  `git status` and `git log` yourself.
