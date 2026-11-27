---
release: minor
---

### Added

- `jig dispatch check [--repo <path>]` checks the configuration the dispatcher's tick reads from a repository (its `dispatch` section, the tracker `issue_tracker` names with its issue facets, and the change-area catalog `drive.change_areas_catalog` names) with the tick's own readers, and exits 1 with the tick's message for each reading the tick would refuse. A repository runs it in CI so that such an error is refused before it merges, not found by the host's tick at every turn. It reads files only and sends nothing to the tracker or the forge. [CONFIGURATION.md § `dispatch`](../plugin/CONFIGURATION.md#dispatch) shows a CI step that runs it.
