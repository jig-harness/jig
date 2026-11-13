---
release: patch
---

### Fixed

- The Jira adapter no longer names the account scopes a token needs when Jira
  refuses a dead, expired or invalid token. The scope hint now appears only
  when Jira's answer says a scope does not match; any other 401 or 403 gets
  the credential guidance alone.
