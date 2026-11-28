---
release: patch
---

### Fixed

- The online audit's Jira open-issue counts no longer read every open issue
  of the project. Each count is now one request for Jira's own estimate
  (`search/approximate-count`), shown as approximate, so the audit of a large
  project finishes in seconds instead of half a minute. The counts get 5
  seconds; past that they are reported unchecked, naming the bound, and the
  rest of the audit goes on. The estimate counts what the open read selects
  (statuses outside the Done category, and the configured blocked status),
  not each issue's reading by its own type's state map.
  **Consumer action:** none.
