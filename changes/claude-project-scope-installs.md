---
release: minor
---

### Fixed

- `jig doctor` and `jig upgrade` now see Claude Code's project- and
  local-scope installs of `jig@jig`, not only the user-scope one. The doctor
  lists each with its directory and version in a new `plugin:claude:scopes`
  check, which fails one older than the user-scope install or whose
  directory no longer exists. `jig upgrade` refreshes each from its
  directory, removes from Claude Code's install record each whose directory
  is gone, and names any it leaves as it was; `bun tools/plugin/setup.ts`
  does the same. The plugin README says which copy Claude Code loads where
  both exist.
