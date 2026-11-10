---
release: patch
---

### Fixed

- `jig dispatch` no longer stops a repository's turn with "issue_tracker.facets.size names a store, but the repository's label taxonomy has no size group" when the repository names a size store. The pickup planner reads the size values from the repository's own label taxonomy, as the tracker already does.
