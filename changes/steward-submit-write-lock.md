---
release: patch
---

### Fixed

- Steward submissions reserve their database write before reading, so a
  concurrent dispatcher or session write cannot invalidate the submission's
  snapshot and reject its records.
