---
release: patch
---

### Fixed

- **audit:** `gc.worktree_roots` and `gc.scratch_prefixes` name places that
  exist on some machines only, so a root that is missing where the audit runs
  is no longer reported as a finding.
- **gc:** `jig gc install` run from a linked worktree registers the clone's
  primary checkout, and resolves the declaration's relative roots from it,
  rather than registering the linked worktree.
