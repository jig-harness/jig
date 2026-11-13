---
release: patch
---

### Fixed

- The audit now probes configured Jira and Linear facet stores and reports
  stores that cannot be used, including missing Jira fields or issue types
  and Linear size estimates disabled for the team. Configured GitHub store
  failures are also reported; a probe the tracker could not answer is a
  warning, not an error. Default-store detection advice remains specific to
  GitHub. The Jira probe also shows the open issue counts for the project and
  its configured pool issue-type scope, counted as the pool read counts.
  **Consumer action:** none.
