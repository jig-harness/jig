---
release: patch
---

### Fixed

- Dispatch overlap reports charge a match between different areas only when their globs can match a common path. Areas that share a directory but match different file extensions no longer add an overlap cost.
