---
release: minor
---

### Changed

- `jig dispatch` re-drives a parked pull request that comes to conflict with
  its base. The drive attempts to merge the base in, then parks on unanswered
  questions if repair succeeds. While the re-drive is owed, the pull request carries
  `jig:stale` in place of `jig:parked`. It is re-driven once for each pair of
  its head and its base branch's head. When that re-drive leaves the conflict
  in place (for example two requirements that contradict each other), the
  drive stops `PR_CONFLICTING` and needs a person to resolve it; if it remains
  parked, the park notice says it also conflicts with its base.
