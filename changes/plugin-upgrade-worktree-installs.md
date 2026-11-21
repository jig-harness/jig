---
release: patch
---

### Fixed

- `jig upgrade` (and the scheduled refresh) no longer fails on every run
  when several git worktrees of one repository each hold a Claude Code
  project-scope install of the plugin. `claude plugin update --scope project`
  updates the first install of the repository, not the worktree it runs
  from, so the upgrade now runs it once per repository, reports when it
  refreshed another directory than the one it ran in (naming both), and
  brings each install it cannot reach to the user-scope version in Claude
  Code's install record, reported as `rewritten`. Configuration directories
  sharing one plugins directory then find every install current, so a
  second one runs no update. An install the upgrade still cannot bring
  there, or a user-scope install that is missing or disabled, still fails
  the run. **Consumer action:** none.
