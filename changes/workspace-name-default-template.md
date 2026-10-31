---
release: minor
---

### Changed

- `do-item` and `drive-pr` now rename the Orca workspace they run in by default, to `{id} {status} {title}` (for example `#12 [D] Rename workspaces`). [`workspace_name.template`](../plugin/CONFIGURATION.md#workspace_name) changes the name, and setting it to `""` turns the renaming off.
