---
release: patch
---

### Fixed

- A pickup hold whose dependency the dispatcher reads itself (a pull request
  to merge, an item to close) is a held row under Queue, and `jig ask
  --waiting` no longer lists it as a hold to release: nothing waits on a
  person while the dependency is open. A hold with no dependency, one whose
  stored dependency cannot be read, and one whose pull request closed
  unmerged still wait on a person.
- The members of an ended batch whose pass asked a question about the whole
  batch are released when an open pull request carries the batch's anchor
  (or the anchor's item is in `pr_open`, whether or not its pull request is matched), so they are picked up instead of waiting
  on an answer the anchor cannot take; the anchor keeps its claim.
