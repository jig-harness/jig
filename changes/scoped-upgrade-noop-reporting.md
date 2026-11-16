---
release: patch
---

### Fixed

- `jig upgrade` reports a scoped Claude Code install as left behind when the
  update command succeeds but its record still differs from the user version.
  An incomplete scoped refresh now exits nonzero while preserving the report
  of the user install and installed jobs that succeeded.
