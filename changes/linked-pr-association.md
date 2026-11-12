---
release: patch
---

### Fixed

- Require an explicit tracker-comment association when a pull request has no issue-link line, so unrelated pull request mentions cannot advance an item.
- Require trusted authors for explicit tracker-comment association markers, regardless of repository-name casing, and ignore quoted or code-example association evidence.
