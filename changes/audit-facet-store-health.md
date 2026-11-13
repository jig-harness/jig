---
release: patch
---

### Fixed

- The audit now probes configured Jira and Linear facet stores and reports
  stores that cannot be used, including missing Jira fields or issue types
  and Linear size estimates disabled for the team. Configured GitHub store
  failures are also reported; default-store detection advice remains specific
  to GitHub. The Jira probe also shows approximate open issue counts for the
  project and its configured pool issue-type scope, without fetching issues.
  **Consumer action:** none.
