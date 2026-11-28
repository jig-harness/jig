---
release: patch
---

### Fixed

- The online audit's Jira open-issue counts no longer read every open issue
  of the project. Each count is now one estimate request
  (`search/approximate-count`; the transport may resend one after a transient failure), shown as
  Jira's estimate, so the count phase no longer scales with the size of the project. The counts get 5 seconds, measured from
  when they start, after the forge and tracker checks; past that they are
  reported unchecked, naming the bound, and the rest of the audit goes on.
  The estimate is of what the open read selects (statuses outside the Done
  category, and every configured blocked status name), not each issue's
  reading by its own type's state map, so it can differ from the issues the
  pool reads. The full-audit time is not measured here.
  **Consumer action:** none.
