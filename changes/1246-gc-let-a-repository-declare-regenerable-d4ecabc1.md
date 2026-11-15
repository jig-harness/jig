---
release: patch
---

### Fixed

- Finished worktrees are no longer kept just for the `.fallow` tool cache. Repositories can declare other rebuildable ignored paths with `gc.regenerable_paths`; undeclared content remains protected. Existing installations refresh the collector after upgrading, even without configuration changes, to confirm new default bounds.
