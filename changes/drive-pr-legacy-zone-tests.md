---
release: patch
---

### Fixed

- Drive-pr's quota tests now exercise both acceptance and rejection of the legacy
  `EST5EDT` zone independently of the runtime's zone database, so local gates
  pass on runtimes that reject it. Unsupported reset zones continue to park the
  drive rather than guessing a reset time.
