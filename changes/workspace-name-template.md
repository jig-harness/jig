---
release: minor
---

### Added

- `do-item` and `drive-pr` can rename the workspace they run in after the work and its stage, in Orca, when the repository sets [`workspace_name.template`](../plugin/CONFIGURATION.md#workspace_name). The name can use `{id}`, `{status}`, `{title}` and `{pr}`; the status text is `[I]`, `[D]`, `[R]` and `✅` by default, and `workspace_name.statuses` overrides each. Nothing is renamed without the template.
