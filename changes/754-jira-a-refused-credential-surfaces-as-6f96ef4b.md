---
release: patch
---

### Fixed

- Jira verifies the credential before reading fields or an issue, so anonymous
  reads cannot look like missing fields or a missing issue. Refused credentials
  name the supported environment variables and where to create an API token,
  and are no longer reported as temporary unavailability.
