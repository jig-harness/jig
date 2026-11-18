---
release: patch
---

### Fixed

- A dispatch tick whose forge read the deadline cut short records its open
  pull-request listing as unread, so serialization treats the repository's
  changed files as unavailable for that tick.
