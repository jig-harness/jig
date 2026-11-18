---
release: minor
---

### Added

- Dispatch reads changed files for every open pull request, reuses comparisons
  whose head and base are unchanged, and reports the age of earlier results
  when a fresh read must wait.
