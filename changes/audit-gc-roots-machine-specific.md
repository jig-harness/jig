---
release: patch
---

### Fixed

- **audit:** `gc.worktree_roots` and `gc.scratch_prefixes` name places that
  exist on some machines only, so a root that is missing where the audit runs
  is no longer reported as a finding.
- **gc:** `jig gc install` run from a linked worktree registers the clone's
  primary checkout, and resolves the declaration's relative roots from it,
  rather than registering the linked worktree. An entry an earlier version
  registered for a linked worktree is replaced on the next install, and
  removed by uninstall; `jig gc --collect --repo` from a linked worktree
  collects under the primary checkout's entry, while a report from it still
  reads that worktree's own declaration. Paths compare with symbolic links
  resolved, so an entry naming the clone through another path is the same
  clone's.
