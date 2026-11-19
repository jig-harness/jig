---
release: patch
---

### Fixed

- Use `jig send` with `hold` or `release` at a pickup address to keep an item
  out of dispatch without changing its tracker state or assignee. The hold
  works without a tracker label, and the line shows who placed it and when.
