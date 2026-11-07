---
release: patch
---

### Fixed

- Changelog checks compare an open merge against its resulting ancestry, so
  releases imported from the base branch do not prevent validation before
  the merge is committed. Branch edits to release versions remain errors.
