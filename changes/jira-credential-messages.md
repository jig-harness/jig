---
release: patch
---

### Fixed

- The Jira adapter's error when no credential is set says that
  `JIRA_BEARER_TOKEN`, and the token `JIRA_TOKEN_COMMAND` prints, may be an
  OAuth access token or an API token with scopes, as the configuration
  reference says. It said an OAuth access token only, so someone holding a
  scoped API token read it as the wrong kind of credential.
- When Jira refuses the adapter's read of the account it acts as, or says a
  token's scope does not match, the error now names the scopes a scoped or
  OAuth token needs for that read: the classic `read:jira-user`, or all of
  the granular `read:application-role:jira`, `read:group:jira`,
  `read:user:jira` and `read:avatar:jira`. Before, it said only to check the
  credential.
