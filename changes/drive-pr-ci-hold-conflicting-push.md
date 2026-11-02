---
release: patch
---

### Fixed

- `drive-pr` no longer deadlocks pushing a conflict resolution in a
  repository with a CI hold (`ci.hold_label`). GitHub runs no `pull_request`
  CI on a pull request that conflicts with its base, so the checks the hold
  waited for before it could be added again never ran. This happened after a
  failed push released the hold, or when no CI had ever run on the pull
  request. `ci-hold.ts ensure` now lets that push go ahead without the
  label, and the push that clears the conflict runs full CI. A failed push
  of that kind has no hold to roll back, so `finish-round.ts` no longer
  reports retaining one.
