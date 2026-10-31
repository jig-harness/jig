---
release: minor
---

### Added

- `drive-pr` checks, before it announces merge-readiness, that the Orca
  workspace it drove the pull request in is linked to that pull request, and
  corrects the link when it is missing or names another one
  (`scripts/workspace-pr-link.ts`). Outside Orca it does nothing.
