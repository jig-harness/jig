---
release: patch
---

### Fixed

- Drive state writes distinguish published content whose directory durability is still pending from a failed write. Retrying inbox repair flushes the directory even when its content is already repaired.
