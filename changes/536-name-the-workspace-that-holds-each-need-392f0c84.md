---
release: minor
---

### Added

- Dispatch needs in `jig dispatch line --json` and the dashboard's `GET /state`
  name the workspace holding the work, including parked drives with no running
  session. Unknown or ambiguous workspaces are `null`; notification destinations
  keep their separate meaning.
