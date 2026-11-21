---
release: patch
---

### Fixed

- A follow-up of a merged pull request no longer waits on a person when a
  checkout the workspace runtime does not list still holds the merged
  branch and its commits are already in the squash merge. The idle check
  counts as unpushed only the commits whose change the remote's default
  branch lacks (by tree, by patch, or because merging the checkout into it
  would change nothing, with merge attributes and drivers neutralized or refused; this needs git 2.41), so such a checkout is detached, its
  local branch kept, and the follow-up's launch outcome names the checkout
  and the branch. A checkout that is still busy for its commits names them
  in its reason. A host with git older than 2.41 keeps reading such a checkout as
  busy. **Consumer action:** none.
