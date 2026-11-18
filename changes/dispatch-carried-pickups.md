---
release: minor
---

### Fixed

- `jig dispatch` no longer asks a person about a claimed item as a stalled
  pickup while an open pull request of its repository carries it: one the
  line links to the item (its branch names the item's key, its description
  closes it, or the forge says it closes it), not from a fork, whose drive
  is live or has converged and waits for its merge. The tick reports the
  item as carried by that pull request, with its link and the drive's state,
  and the line the dashboard reads lists it under `carried`, whether or not the
  repository names a `pr_open` state. A pull request with no drive or a
  stopped one still leaves the stalled need, which now names it; where the
  open pull requests or the drive did not read, the need says what could not
  be told.
