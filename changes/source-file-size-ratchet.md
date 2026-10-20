---
release: patch
---

### Added

- M1's reference ratchet can count source and test lines above a configured
  file-size limit, preventing total excess from growing while existing files
  are split. A scope that matches no file is a configuration error rather
  than a pass.

### Changed

- The review driver's implementation and large test suites are split by
  responsibility, preserving the commands skills invoke from the plugin cache.
