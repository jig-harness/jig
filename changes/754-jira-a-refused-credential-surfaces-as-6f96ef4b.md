---
release: patch
---

### Fixed

- Jira verifies the credential before reading fields, issues or searches, so
  anonymous reads cannot look like missing data. OAuth tokens need Jira's
  classic `read:jira-user` scope, or the granular scope alternative, for that
  identity check; add the applicable set before upgrading a token that only
  read issues. Any refused Jira request names the supported environment
  variables and where to create an API token, while a timed-out token broker
  remains a temporary-unavailability error.
