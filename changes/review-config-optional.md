---
release: minor
---

### Changed

- `resolve-review-comments` runs with only `gates.command` configured.
  `review.bots` and `review.deferral_team` are optional: without
  `review.bots` every reviewer's threads are worked, as they already were
  whatever the list named, and without `review.deferral_team` a deferral
  names its team with `--team`. A repository with no `review` section no
  longer stops at the configuration step.
