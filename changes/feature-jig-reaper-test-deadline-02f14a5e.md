---
release: patch
---

### Fixed

- The reaper's entry-count regression fixture creates and backdates files with
  bounded concurrency, reducing setup time on macOS while preserving coverage
  of the real warning threshold and the count after cleanup.
