---
release: patch
---

### Fixed

- Finished worktrees are no longer kept just for the `.fallow` tool cache. Repositories can declare other rebuildable ignored paths with `gc.regenerable_paths`; undeclared content remains protected. After adding paths, refresh the installed collector to confirm its bounds.
