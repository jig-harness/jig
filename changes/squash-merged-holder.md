---
release: patch
---

### Fixed

- A follow-up of a merged pull request no longer waits on a person when a
  checkout the workspace runtime does not list still holds the merged
  branch and its commits are already in the squash merge. The idle check
  counts as unpushed only the commits whose change the remote's default
  branch lacks (by tree or by patch), so such a checkout is detached, its
  local branch kept, and the follow-up's launch outcome names the checkout
  and the branch. A checkout that is still busy for its commits names them
  in its reason. **Consumer action:** none.
