---
release: minor
---

### Removed

- **Breaking:** `do-item` and `drive-pr` no longer rename the Orca or Herdr workspace they run in as the work moves from implementing to driving to ready. A workspace keeps the name it was created with, or the one a person gives it; where the work stands shows on the Orca board card, the workspace's comment, the pull request and the dispatch dashboard. The `workspace_name` section (`template`, `statuses`) has no effect: a file that still sets it loads as before, and the audit's configuration check notes it once. The `workspace-name.ts` script is gone. **Consumer action:** advised at configuration, instructions. Remove `workspace_name` from `.config/jig.yaml`, and any runbook step that expects a renamed workspace. **Detect:** `config:workspace_name`, `text:workspace-name.ts`.
