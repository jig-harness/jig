---
release: minor
---

### Changed

- The default `workspace_name.template` now ends with the pull request: `{id} {status} {title} {pr}` (for example `<item-id> [D] Rename workspaces #<number>`). The suffix appears once the work has a pull request, so the name at pickup is unchanged. [`workspace_name.template`](../plugin/CONFIGURATION.md#workspace_name) sets another name, and `""` turns the renaming off.
