---
release: patch
---

### Fixed

- `resolve-conflicts`: the resolution check no longer refuses a merge
  because the base branch's own migration journal lists its migrations out
  of sequence order or with timestamps out of order, as a journal does when a
  long-lived branch's migration merged late. The committed journal is taken
  as given: the check fails only when the resolution drops or changes one of
  its entries, or the branch's migrations do not follow it in sequence order
  with later timestamps. A conflict round on a repository with such a
  journal, including one whose pull request adds no migration, can conclude
  again.
