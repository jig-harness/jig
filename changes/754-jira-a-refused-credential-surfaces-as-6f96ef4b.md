---
release: patch
---

### Fixed

- Jira verifies the credential before reading fields, issues or searches, so
  anonymous reads cannot look like missing data. OAuth tokens now need Jira's
  `read:jira-user` scope for that identity check; add it before upgrading a
  token that only read issues. Refused credentials name the supported
  environment variables and where to create an API token, while a timed-out
  token broker remains a temporary-unavailability error.
