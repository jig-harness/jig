---
release: minor
---

### Added

- `failures.group` in the machine's dispatch file: `cause`, the default,
  tells this host's own failing turns once per cause (the session runtime,
  the state database, the configuration, the tracker, the forge, other),
  naming every repository and tick scope that cause fails, so one host fault
  is no longer told once for each scope it touches; `scope` keeps one notice
  per scope. Each scope still backs off and clears on its own.
  **Consumer action:** none.
