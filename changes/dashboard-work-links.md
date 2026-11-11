---
release: minor
---

### Added

- The dispatch dashboard's line now says which work each row is linked to
  and which tracker each repository uses, for the page and for any program
  that reads `jig dispatch line --json`. A pull request's row carries the
  tracker items its branch names, its description closes (`Closes`, `Fixes`,
  `Resolves`) or GitHub says it closes; an item's row carries the open pull
  requests that do; each repository carries its configured tracker adapter.
  The tick reads them from the query of open pull requests it already makes,
  which now also asks for each pull request's closing issues: one more of
  the forge's rate points per page of 50 pull requests. A row the tick could
  not tell about carries no links rather than an empty list. The page shows
  nothing new yet.
