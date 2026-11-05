---
release: patch
---

### Changed

- Refresh the dashboard's dependencies and bundled YAML parser, and update the
  changelog workflow template to use checkout v7.

### Fixed

- Keep the structured-artifact comparison gate's rejection of numeric overflow
  when the YAML parser would otherwise retain the literal as a string.
- Exercise scheduler upgrade checks with the host's supported schedulers, and
  limit the separate service-and-timer check to systemd hosts.
