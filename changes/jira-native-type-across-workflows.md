---
release: patch
---

### Fixed

- On Jira, with type kept in the issue types (`issue_tracker.facets.type`
  `store: native`), changing an issue's type to an issue type of another
  workflow failed with Jira's bare `400 issuetype: The issue type selected is
  invalid`. The adapter now checks the issue's edit screen first and refuses
  the change before anything is written, naming the facet, both issue types
  and the remedies: move the issue in Jira, or keep type in labels or a
  field.
