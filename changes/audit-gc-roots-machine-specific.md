---
release: patch
---

### Fixed

- **audit:** `gc.worktree_roots` and `gc.scratch_prefixes` name places that
  exist on some machines only, so a root that is missing where the audit runs
  is no longer reported as a finding.
