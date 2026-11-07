---
release: minor
---

### Changed

- `jig dispatch` re-drives a parked pull request that comes to conflict with
  its base. The drive merges the base in, then parks again on the questions
  still unanswered. While the re-drive is owed, the pull request carries
  `jig:stale` in place of `jig:parked`. It is re-driven once for each pair of
  its head and its base branch's head. When that re-drive leaves the conflict
  in place (for example two requirements that contradict each other), the
  pull request goes back to `jig:parked`, and the park notice says it also
  conflicts with its base.
