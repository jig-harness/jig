---
release: patch
---

### Fixed

- The Jira adapter refuses a `JIRA_BEARER_TOKEN` or `JIRA_TOKEN_COMMAND`
  credential for an Atlassian Cloud site (`*.atlassian.net`) when
  `issue_tracker.jira.api_base` is not set, before it sends a request, and
  says the setting is needed. Before, the site answered a bare `Jira API HTTP
  403`. A self-hosted site named in `JIRA_ALLOWED_HOSTS` is left alone, and a
  403 on its first request now names the credential variable.
