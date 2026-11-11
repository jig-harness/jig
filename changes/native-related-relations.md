---
release: minor
---

### Changed

- **GitHub: `related` is GitHub's own related link.** `tracker.ts relate "#a"
  related "#b"` now writes GitHub's related link (`addRelatesTo`) and no
  comment, and `relations` reads it from the issue's `relatesTo`. The comments
  earlier versions wrote (`<!-- jig:related … -->`) are still read as related
  links until they are converted.
- **Execution plans: the tracker's `blocks` may not contradict a plan.** Pickup
  and the dispatcher refuse an epic's plan when the tracker's `blocks` makes an
  issue wait for another that the plan puts after it, and name both issues.
  Remove the wrong side, or re-run the planner. A dependency the plan states
  and the tracker lacks is not refused.

### Added

- **`tracker.ts migrate-relations [--dry-run]`** converts each legacy GitHub
  `related` comment into a native related link and marks the comment
  superseded, then reports what it converted. Run it again after a failure; it
  only does what is left. Run it once on each repository that used the old
  form.
- **`tracker.ts sync-plan-blocks <epic-key> [--dry-run]`** writes the
  dependency edges of an epic's execution plan as native `blocks` relations the
  tracker lacks, so a planner states a dependency in both places.
- The rule behind both is recorded in ADR-0015: parent, blocks, related and
  duplicate live only in the tracker's own relationships.
