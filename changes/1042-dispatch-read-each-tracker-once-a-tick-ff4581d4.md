---
release: patch
---

### Fixed

- Repositories sharing a tracker scope and served people reuse one queue reading even when their state maps or facet settings differ, reducing repeated dispatcher requests while preserving each repository's interpretation. **Consumer action:** none.
