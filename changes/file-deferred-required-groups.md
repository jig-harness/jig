---
release: minor
---

### Added

- `file-deferred.ts` (resolve-review-comments) files a deferred finding into a
  repository whose label taxonomy requires a group beyond the size, such as a
  `repo` group: it takes that group's label from the change-area catalog's
  areas covering the file the finding's review thread is on. A finding whose
  group it cannot derive with certainty (a summary finding, a file no area
  covers, or areas carrying none or several of the group's labels) stays in
  the pull request's `## Deferred` section for a person, naming the group,
  and the other entries are filed instead of the run stopping on the
  tracker's refusal.
