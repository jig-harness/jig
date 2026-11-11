---
release: patch
---

### Fixed

- Require an explicit tracker-comment association when a pull request has no issue-link line, so unrelated pull request mentions cannot advance an item.
- Accept linked pull request evidence only from trusted tracker comments, regardless of repository-name casing, and ignore quoted or code-example issue links.
