---
release: patch
---

### Fixed

- The plugin's mechanisms page said every kind `jig gc` inventories is
  report-only. It now says what holds: scratch folders and tool state are
  reported, a worktree Orca manages is collected through Orca when the
  machine entry names Orca's command, and every other worktree is reported
  ([MECHANISMS.md](../plugin/MECHANISMS.md#resource-collection-jig-gc)).
