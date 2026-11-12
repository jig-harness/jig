---
release: patch
---

### Fixed

- A Jira `JIRA_TOKEN_COMMAND` that overruns the request's deadline now fails
  with an error that names `JIRA_TOKEN_COMMAND` and counts as temporarily
  unavailable, instead of a generic "Jira request cancelled" error.
- After the command's second run prints a token Jira refuses too, the adapter
  stops running the command and fails each request with the credential
  guidance, so a revoked credential no longer sends a broker call with every
  request. A later accepted request re-enables renewal.
