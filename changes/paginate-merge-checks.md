---
release: patch
---

### Fixed

- The Ready board, merge-ready announcement and `jig ask` read additional
  pages of checks on the verified pull request head. A pull request with
  more than 100 checks can reach the merge lane once all required checks
  pass. The shared reader leaves the pull request partial if it cannot
  read the full connection within four pages or its deadline.
